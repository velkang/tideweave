import { MONAD_TOKENS, UNISWAP_V3_MONAD, buildMonadSwap, monadSwapPayloadHash, type MonadV3Pool } from "@tideweave/chain";
import { encodeFunctionResult, getAddress, keccak256, parseAbi, parseTransaction, type Address, type Hex,
  type TransactionSerializableEIP1559 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { UnsignedTransaction } from "../src/delegation";
import type { LoadedMainnetIntent, MainnetEvaluation } from "../src/mainnet-evaluator";
import { executeMainnetIntent, type MainnetExecutionRpc } from "../src/mainnet-executor";

const now = 1_000_000_000;
const pool = getAddress("0x3333333333333333333333333333333333333333");
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const SQRT_PRICE = BigInt(Math.round(Math.sqrt(3e-14) * 2 ** 96));
const ONE = 10n ** 18n;

function setup(liveOut: bigint) {
  const account = privateKeyToAccount(generatePrivateKey());
  const pair: MonadV3Pool = { chainId: 143, venue: "uniswap-v3", id: pool,
    token0: { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18 },
    token1: { address: MONAD_TOKENS.USDC, symbol: "USDC", decimals: 6 }, fee: 3000, tickSpacing: 60,
    sqrtPriceX96: SQRT_PRICE, tick: -322_000, liquidity: 10n ** 18n };
  const swap = buildMonadSwap({ pair, tokenIn: MONAD_TOKENS.WMON, amountIn: ONE, amountOutMinimum: 29_601n,
    recipient: account.address, deadline: BigInt(now / 1_000 + 600) });
  const intent: LoadedMainnetIntent = { intentId: "monad_swap_1", kind: "monad_swap", status: "pending",
    expiresAt: now + 60_000, payloadHash: monadSwapPayloadHash(swap),
    wallet: { address: account.address, state: "active" },
    transaction: { chainId: 143, to: swap.to, data: swap.data, value: 0n },
    custody: { walletId: "wallet-1", dynamicWalletId: "dynamic-1", address: account.address },
    monadSwap: { venue: "uniswap-v3", pairId: pool, tokenIn: MONAD_TOKENS.WMON, amountIn: ONE,
      amountOutMinimum: 29_601n, deadline: swap.deadline } };
  const evaluations: MainnetEvaluation[] = [];
  const broadcast: Hex[] = [];
  const rpc = {
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getCode: async ({ address }: { address: Address }) => address === account.address ? undefined : "0x6000",
    getBalance: async () => 50n * ONE,
    call: async ({ to }: { to: Address }) => to === UNISWAP_V3_MONAD.quoterV2
      ? { data: encodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInputSingle",
        result: [liveOut, 0n, 0, 0n] }) } : { data: "0x" },
    simulateContract: async () => { throw new Error("not used"); },
    getTransactionCount: async () => 9,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
    estimateGas: async () => 150_000n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      broadcast.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (address === UNISWAP_V3_MONAD.factory) return pool;
      if (address === pool) {
        return ({ factory: UNISWAP_V3_MONAD.factory, token0: MONAD_TOKENS.WMON, token1: MONAD_TOKENS.USDC, fee: 3000,
          tickSpacing: 60, slot0: [SQRT_PRICE, -322_000, 0, 0, 0, 0, true], liquidity: 10n ** 18n } as
          Record<string, unknown>)[functionName];
      }
      if (functionName === "decimals") return address === MONAD_TOKENS.USDC ? 6 : 18;
      if (functionName === "symbol") return address === MONAD_TOKENS.USDC ? "USDC" : "WMON";
      if (functionName === "balanceOf" || functionName === "allowance") return 5n * ONE;
      throw new Error(`Unexpected ${functionName} on ${address}`);
    },
  } as unknown as MainnetExecutionRpc;
  const run = () => executeMainnetIntent({ intentId: intent.intentId,
    evaluationStore: { load: async () => intent, save: async (value) => { evaluations.push(value); } },
    reservationStore: { reserve: async () => true, release: async () => undefined },
    submissionStore: { commit: async () => true, loadReservation: async () => ({ intentId: intent.intentId,
      walletId: "wallet-1", nonce: 9, leaseExpiresAt: now + 30_000, intentStatus: "pending",
      intentExpiresAt: now + 60_000 }) } as never,
    rpc, signTransaction: async (_id: string, transaction: UnsignedTransaction) =>
      account.signTransaction(transaction as TransactionSerializableEIP1559),
    emergencyStop: false, now: () => now });
  return { swap, run, evaluations, broadcast };
}

describe("executing a swap", () => {
  it("re-quotes, then signs exactly the stored swap", async () => {
    const { swap, run, evaluations, broadcast } = setup(29_900n);
    await run();
    expect(evaluations[0]).toMatchObject({ decision: "allowed" });
    expect(parseTransaction(broadcast[0])).toMatchObject({ type: "eip1559", data: swap.data, nonce: 9 });
  });

  it("refuses when the pool no longer gives the stored minimum", async () => {
    const { run, evaluations, broadcast } = setup(29_000n);
    await expect(run()).rejects.toMatchObject({ code: "MINIMUM_NO_LONGER_MET" });
    expect(evaluations[0]).toMatchObject({ decision: "rejected", reasonCode: "MINIMUM_NO_LONGER_MET" });
    expect(broadcast).toEqual([]);
  });
});
