import { MONAD_TOKENS, SIMPLE_7702_ACCOUNT, buildNadAdd, buildNadDelegationClear, buildNadRemove, readDelegate,
  readNadPair, type MonadNadPair, type MonadV3PoolClient, type NadAdd, type NadDelegationClear,
  type NadRemove } from "@tideweave/chain";
import { concat, parseAbi, type Address } from "viem";
import type { LoadedMainnetIntent, MainnetAuditClient, MainnetEvaluation } from "./mainnet-evaluator";
import { isNadIntentKind, validateNadIntent } from "./monad-nadfun-policy";
import type { StoredNadIntent } from "./monad-nadfun-store";

const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

type Expected = NadAdd | NadRemove | NadDelegationClear;
type Rebuilt = { expected: Expected; pair?: MonadNadPair } | { rejected: string };

async function balances(client: MainnetAuditClient, owner: Address, tokens: Address[], blockNumber: bigint) {
  return Promise.all(tokens.map(async (token) => BigInt(await client.readContract({ address: token,
    abi: balanceAbi, functionName: "balanceOf", args: [owner], blockNumber }) as bigint)));
}

/**
 * Rebuilds the batch from its stored preview against the live pair, and checks the wallet still
 * holds what the preview assumed: the guards in the batch are measured from those balances.
 */
async function rebuild(stored: StoredNadIntent, loaded: LoadedMainnetIntent, client: MainnetAuditClient,
  blockNumber: bigint): Promise<Rebuilt> {
  const wallet = loaded.wallet.address;
  if (stored.action === "clear") return { expected: buildNadDelegationClear({ wallet }) };
  const preview = stored.pair;
  if (!preview || stored.slippageBps === undefined) return { rejected: "NAD_CONTEXT_MISSING" };
  const live = await readNadPair({ client: client as unknown as MonadV3PoolClient, pairAddress: preview.address,
    blockNumber });
  if (live.token0.address !== preview.token0 || live.token1.address !== preview.token1 ||
      live.token0.decimals !== preview.token0Decimals || live.token1.decimals !== preview.token1Decimals) {
    return { rejected: "PAIR_CHANGED" };
  }
  const snapshot = { ...live, reserve0: preview.reserve0, reserve1: preview.reserve1, totalSupply: preview.totalSupply };
  const [lp, balance0, balance1] = await balances(client, wallet, [live.id, live.token0.address, live.token1.address],
    blockNumber);
  if (stored.action === "add") {
    if (stored.amount0Desired === undefined || stored.amount1Desired === undefined || stored.lpBefore === undefined ||
        stored.wrapAmount === undefined) return { rejected: "NAD_CONTEXT_MISSING" };
    if (lp !== stored.lpBefore) return { rejected: "LP_BALANCE_CHANGED" };
    const expected = buildNadAdd({ pair: snapshot, wallet, amount0Desired: stored.amount0Desired,
      amount1Desired: stored.amount1Desired, slippageBps: stored.slippageBps, lpBefore: stored.lpBefore,
      wrapAmount: stored.wrapAmount });
    const wmon0 = live.token0.address === MONAD_TOKENS.WMON;
    const [mon] = [await client.getBalance({ address: wallet, blockNumber })];
    if (balance0 + (wmon0 ? stored.wrapAmount : 0n) < expected.amount0 ||
        balance1 + (wmon0 ? 0n : stored.wrapAmount) < expected.amount1 || mon < stored.wrapAmount) {
      return { rejected: "NAD_ASSETS_CHANGED" };
    }
    return { expected, pair: live };
  }
  if (stored.liquidity === undefined || stored.balance0Before === undefined || stored.balance1Before === undefined) {
    return { rejected: "NAD_CONTEXT_MISSING" };
  }
  if (lp < stored.liquidity) return { rejected: "LP_BALANCE_CHANGED" };
  if (balance0 !== stored.balance0Before || balance1 !== stored.balance1Before) return { rejected: "NAD_ASSETS_CHANGED" };
  return { pair: live, expected: buildNadRemove({ pair: snapshot, wallet, liquidity: stored.liquidity,
    slippageBps: stored.slippageBps, balance0Before: stored.balance0Before, balance1Before: stored.balance1Before }) };
}

/** Re-checks a nad.fun intent against the chain just before signing. */
export async function evaluateNadLoaded(input: { loaded: LoadedMainnetIntent; client: MainnetAuditClient;
  blockNumber: bigint; emergencyStop: boolean; now: number }): Promise<MainnetEvaluation> {
  const { loaded, client, blockNumber, now } = input;
  const finish = (decision: "allowed" | "rejected", reasonCode: string): MainnetEvaluation => ({
    intentId: loaded.intentId, decision, reasonCode, blockNumber: Number(blockNumber), createdAt: now });
  if (!isNadIntentKind(loaded.kind)) return finish("rejected", "INTENT_KIND_INVALID");
  if (loaded.automation) return finish("rejected", "AUTOMATION_NOT_READY");
  const stored = loaded.monadNadfun;
  if (!stored) return finish("rejected", "NAD_CONTEXT_MISSING");
  if (!client.getCode) return finish("rejected", "DELEGATION_CHECK_UNAVAILABLE");
  try {
    const delegate = await readDelegate({ getCode: client.getCode }, loaded.wallet.address, blockNumber);
    const rebuilt = await rebuild(stored, loaded, client, blockNumber);
    if ("rejected" in rebuilt) return finish("rejected", rebuilt.rejected);
    if (rebuilt.expected.kind !== "clear") {
      // Simulated as the wallet will run it: delegated, even before its first batch.
      await client.call({ account: loaded.wallet.address, to: loaded.wallet.address, data: loaded.transaction.data,
        value: 0n, blockNumber, ...(delegate === null ? { stateOverride: [{ address: loaded.wallet.address,
          code: concat(["0xef0100", SIMPLE_7702_ACCOUNT]) }] } : {}) });
    }
    const decision = validateNadIntent({ now, emergencyStop: input.emergencyStop, wallet: loaded.wallet,
      intent: { kind: loaded.kind, status: loaded.status, expiresAt: loaded.expiresAt, payloadHash: loaded.payloadHash },
      transaction: loaded.transaction, pair: rebuilt.pair, expected: rebuilt.expected, delegate,
      simulation: { success: true, blockNumber, latestBlockNumber: blockNumber } });
    return finish(decision.allowed ? "allowed" : "rejected", decision.reason);
  } catch (error) {
    console.error("nad.fun chain revalidation failed for intent:", loaded.intentId, error);
    return finish("rejected", "CHAIN_REVALIDATION_FAILED");
  }
}
