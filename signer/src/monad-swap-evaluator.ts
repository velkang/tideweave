import { monadAutomationReason } from './monad-automation-policy';
import { UNISWAP_V4_MONAD, buildMonadSwap, buildSwapApproval, isLivePairAlmostEmpty, quoteMonadSwap,
  readMonUsd, readMonadV3Pool, readMonadV4Pool, readNadPair, swapSpender, type MonadSwap, type MonadV3PoolClient,
  type SwapPair, type SwapQuoteClient } from "@tideweave/chain";
import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import type { LoadedMainnetIntent, MainnetAuditClient, MainnetEvaluation } from "./mainnet-evaluator";
import { validateSwapApproval, validateSwapIntent } from "./monad-swap-policy";
import type { StoredSwapPair } from "./monad-swap-store";

const tokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

/** The swap's pool or pair read live, checked to be the one stored. */
async function livePair(client: MonadV3PoolClient, stored: StoredSwapPair, blockNumber: bigint): Promise<SwapPair> {
  if (stored.venue === "uniswap-v3") return readMonadV3Pool({ client, poolAddress: getAddress(stored.pairId), blockNumber });
  if (stored.venue === "nadfun-v2") return readNadPair({ client, pairAddress: getAddress(stored.pairId), blockNumber });
  if (!stored.key) throw new Error("SWAP_POOL_KEY_MISSING");
  const pool = await readMonadV4Pool({ client, key: stored.key, blockNumber });
  if (pool.id.toLowerCase() !== stored.pairId.toLowerCase()) throw new Error("SWAP_POOL_MISMATCH");
  return pool;
}

/** True when the wallet still holds and has approved what the swap spends. */
async function inputReady(client: MainnetAuditClient, swap: MonadSwap, owner: Address, blockNumber: bigint) {
  if (swap.tokenIn === zeroAddress) return await client.getBalance({ address: owner, blockNumber }) >= swap.amountIn;
  const { erc20Spender, permit2Spender } = swapSpender(swap.venue);
  const read = (functionName: "balanceOf" | "allowance", args: readonly [Address] | readonly [Address, Address]) =>
    client.readContract({ address: swap.tokenIn, abi: tokenAbi, functionName, args, blockNumber } as never) as
      Promise<bigint>;
  const [balance, allowance] = await Promise.all([read("balanceOf", [owner]), read("allowance", [owner, erc20Spender])]);
  if (balance < swap.amountIn || allowance < swap.amountIn) return false;
  if (!permit2Spender) return true;
  const permit = await client.readContract({ address: UNISWAP_V4_MONAD.permit2, abi: permit2Abi,
    functionName: "allowance", args: [owner, swap.tokenIn, permit2Spender], blockNumber } as never) as
    readonly [bigint, number, number];
  return permit[0] >= swap.amountIn && BigInt(permit[1]) > swap.deadline;
}

/** Re-checks a swap or swap approval against the chain just before signing, re-quoting the swap. */
export async function evaluateSwapLoaded(input: { loaded: LoadedMainnetIntent; client: MainnetAuditClient;
  blockNumber: bigint; emergencyStop: boolean; now: number }): Promise<MainnetEvaluation> {
  const { loaded, client, blockNumber, now } = input;
  const finish = (decision: "allowed" | "rejected", reasonCode: string): MainnetEvaluation => ({
    intentId: loaded.intentId, decision, reasonCode, blockNumber: Number(blockNumber), createdAt: now });
  const stored = loaded.monadSwap ?? loaded.monadSwapApproval;
  if (!stored) return finish("rejected", "SWAP_CONTEXT_MISSING");
  const pairClient = client as unknown as MonadV3PoolClient;
  const common = { now, emergencyStop: input.emergencyStop, wallet: loaded.wallet,
    intent: { status: loaded.status, expiresAt: loaded.expiresAt, payloadHash: loaded.payloadHash },
    transaction: loaded.transaction };
  try {
    const pair = await livePair(pairClient, stored, blockNumber);
    if (loaded.automation) {
      if (pair.venue === 'nadfun-v2') return finish('rejected', 'MANDATE_KIND_NOT_ALLOWED');
      const token = loaded.monadSwap?.tokenIn ?? loaded.monadSwapApproval!.token;
      const amount = loaded.monadSwap?.amountIn ?? loaded.monadSwapApproval!.amount;
      const reason = monadAutomationReason(loaded, pair, await readMonUsd(pairClient, blockNumber).catch(() => null),
        { amount0: token.toLowerCase() === pair.token0.address.toLowerCase() ? amount : 0n,
          amount1: token.toLowerCase() === pair.token1.address.toLowerCase() ? amount : 0n });
      if (reason) return finish('rejected', reason);
    }
    if (loaded.monadSwapApproval) {
      const approval = loaded.monadSwapApproval;
      const expected = buildSwapApproval({ pair, token: approval.token, stage: approval.stage, amount: approval.amount,
        expiration: approval.stage === "permit2" ? approval.expiration : undefined });
      await client.call({ account: loaded.wallet.address, to: loaded.transaction.to, data: loaded.transaction.data,
        value: 0n, blockNumber });
      const decision = validateSwapApproval({ ...common, pair, expected,
        simulation: { success: true, blockNumber, latestBlockNumber: blockNumber } });
      return finish(decision.allowed ? "allowed" : "rejected", decision.reason);
    }
    const swap = loaded.monadSwap!;
    const expected = buildMonadSwap({ pair, tokenIn: swap.tokenIn, amountIn: swap.amountIn,
      amountOutMinimum: swap.amountOutMinimum, recipient: loaded.wallet.address, deadline: swap.deadline });
    if (!(await inputReady(client, expected, loaded.wallet.address, blockNumber))) {
      return finish("rejected", "SWAP_ASSETS_OR_ALLOWANCES_CHANGED");
    }
    const [live, monUsd] = await Promise.all([
      quoteMonadSwap({ client: client as unknown as SwapQuoteClient, pair, tokenIn: swap.tokenIn, amountIn: swap.amountIn,
        blockNumber }).catch(() => ({ amountOut: 0n, priceImpactBps: 10_000 })),
      readMonUsd(pairClient, blockNumber).catch(() => null),
    ]);
    await client.call({ account: loaded.wallet.address, to: loaded.transaction.to, data: loaded.transaction.data,
      value: loaded.transaction.value, blockNumber });
    const decision = validateSwapIntent({ ...common, pair, expected,
      live: { ...live, almostEmpty: isLivePairAlmostEmpty(pair, monUsd) },
      simulation: { success: true, blockNumber, latestBlockNumber: blockNumber } });
    return finish(decision.allowed ? "allowed" : "rejected", decision.reason);
  } catch (error) {
    console.error("Swap chain revalidation failed for intent:", loaded.intentId, error);
    return finish("rejected", "CHAIN_REVALIDATION_FAILED");
  }
}
