import { getAddress, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, UNISWAP_V3_MONAD, UNISWAP_V4_MONAD, buildMonadSwap, buildSwapApproval,
  monadSwapPayloadHash, monadV4PoolId, swapApprovalPayloadHash, type MonadV3Pool,
  type MonadV4Pool } from "@tideweave/chain";
import { validateSwapApproval, validateSwapIntent, type SwapPolicyRequest } from "../src/monad-swap-policy";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const usdc = { address: MONAD_TOKENS.USDC, symbol: "USDC", decimals: 6 };
const v3: MonadV3Pool = { chainId: MONAD_CHAIN_ID, venue: "uniswap-v3",
  id: getAddress("0x3333333333333333333333333333333333333333"),
  token0: { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18 }, token1: usdc, fee: 3000, tickSpacing: 60,
  sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 10n ** 18n };
const key = { currency0: zeroAddress, currency1: MONAD_TOKENS.USDC, fee: 500, tickSpacing: 10, hooks: zeroAddress };
const v4: MonadV4Pool = { chainId: MONAD_CHAIN_ID, venue: "uniswap-v4", id: monadV4PoolId(key), ...key,
  token0: { address: zeroAddress, symbol: "MON", decimals: 18 }, token1: usdc, sqrtPriceX96: 2n ** 96n, tick: 0,
  liquidity: 10n ** 18n, lpFee: 500 };
const now = 1_000_000_000;
const deadline = BigInt(now / 1_000 + 600);
const swap = buildMonadSwap({ pair: v3, tokenIn: MONAD_TOKENS.WMON, amountIn: 1_000n, amountOutMinimum: 900n,
  recipient: wallet, deadline });

function request(overrides: Partial<SwapPolicyRequest> = {}): SwapPolicyRequest {
  const expected = overrides.expected ?? swap;
  return { now, emergencyStop: false, wallet: { address: wallet, state: "active" },
    intent: { status: "pending", expiresAt: now + 60_000, payloadHash: monadSwapPayloadHash(expected) },
    transaction: { chainId: 143, to: expected.to, data: expected.data, value: expected.value },
    pair: v3, expected, live: { amountOut: 950n, priceImpactBps: 30, almostEmpty: false },
    simulation: { success: true, blockNumber: 100n, latestBlockNumber: 100n }, ...overrides };
}
const reject = (reason: string) => ({ allowed: false, reason });

describe("swap signer policy", () => {
  it("allows the exact swap while the pool still gives at least its minimum", () => {
    expect(validateSwapIntent(request()).allowed).toBe(true);
  });

  it("refuses when the pool no longer gives the stored minimum, or moves too much", () => {
    expect(validateSwapIntent(request({ live: { amountOut: 899n, priceImpactBps: 30, almostEmpty: false } })))
      .toEqual(reject("MINIMUM_NO_LONGER_MET"));
    expect(validateSwapIntent(request({ live: { amountOut: 950n, priceImpactBps: 501, almostEmpty: false } })))
      .toEqual(reject("PRICE_IMPACT_TOO_HIGH"));
    expect(validateSwapIntent(request({ live: { amountOut: 950n, priceImpactBps: 30, almostEmpty: true } })))
      .toEqual(reject("POOL_ALMOST_EMPTY"));
  });

  it("only pays the wallet, through the venue's router, before the deadline", () => {
    const elsewhere = buildMonadSwap({ pair: v3, tokenIn: MONAD_TOKENS.WMON, amountIn: 1_000n, amountOutMinimum: 900n,
      recipient: getAddress("0x9999999999999999999999999999999999999999"), deadline });
    expect(validateSwapIntent(request({ expected: elsewhere }))).toEqual(reject("SWAP_CONSTRAINT_INVALID"));
    const late = buildMonadSwap({ pair: v3, tokenIn: MONAD_TOKENS.WMON, amountIn: 1_000n, amountOutMinimum: 900n,
      recipient: wallet, deadline: deadline + 3_600n });
    expect(validateSwapIntent(request({ expected: late }))).toEqual(reject("SWAP_CONSTRAINT_INVALID"));
    expect(validateSwapIntent({ ...request(), transaction: { ...request().transaction, to: wallet } }))
      .toEqual(reject("TRANSACTION_MISMATCH"));
  });

  it("allows value only when selling native MON into a v4 pool, and only that amount", () => {
    const native = buildMonadSwap({ pair: v4, tokenIn: zeroAddress, amountIn: 1_000n, amountOutMinimum: 900n,
      recipient: wallet, deadline });
    expect(validateSwapIntent(request({ pair: v4, expected: native })).allowed).toBe(true);
    const valid = request({ pair: v4, expected: native });
    expect(validateSwapIntent({ ...valid, transaction: { ...valid.transaction, value: 1_001n } }))
      .toEqual(reject("NATIVE_VALUE_NOT_ALLOWED"));
    const withValue = request();
    expect(validateSwapIntent({ ...withValue, transaction: { ...withValue.transaction, value: 1n } }))
      .toEqual(reject("NATIVE_VALUE_NOT_ALLOWED"));
  });

  it("stops swaps under the emergency stop and for a paused wallet", () => {
    expect(validateSwapIntent(request({ emergencyStop: true }))).toEqual(reject("EMERGENCY_STOP_ACTIVE"));
    expect(validateSwapIntent(request({ wallet: { address: wallet, state: "paused" } })))
      .toEqual(reject("WALLET_NOT_SIGNABLE"));
  });

  it("refuses stale simulations and spent intents", () => {
    expect(validateSwapIntent(request({ simulation: { success: true, blockNumber: 100n, latestBlockNumber: 105n } })))
      .toEqual(reject("SIMULATION_STALE"));
    const spent = request();
    expect(validateSwapIntent({ ...spent, intent: { ...spent.intent, payloadHash: `0x${"00".repeat(32)}` as Hex } }))
      .toEqual(reject("PAYLOAD_HASH_MISMATCH"));
  });
});

describe("swap approval signer policy", () => {
  const approval = buildSwapApproval({ pair: v3, token: MONAD_TOKENS.WMON, stage: "erc20", amount: 1_000n });
  const base = { now, emergencyStop: false, wallet: { address: wallet, state: "active" as const },
    intent: { status: "pending", expiresAt: now + 60_000, payloadHash: swapApprovalPayloadHash(approval) },
    transaction: { chainId: 143, to: approval.to, data: approval.data, value: 0n }, pair: v3, expected: approval,
    simulation: { success: true, blockNumber: 100n, latestBlockNumber: 100n } };

  it("allows approving the venue's own spender for a pair token", () => {
    expect(validateSwapApproval(base).allowed).toBe(true);
    expect(approval.spender).toBe(UNISWAP_V3_MONAD.swapRouter02);
  });

  it("refuses another spender, and a Permit2 approval lasting over three days", () => {
    expect(validateSwapApproval({ ...base, expected: { ...approval, spender: wallet } }))
      .toEqual(reject("APPROVAL_CONSTRAINT_INVALID"));
    const permit2 = buildSwapApproval({ pair: v4, token: MONAD_TOKENS.USDC, stage: "permit2", amount: 1n,
      expiration: BigInt(now / 1_000 + 4 * 24 * 3600) });
    expect(permit2.spender).toBe(UNISWAP_V4_MONAD.universalRouter);
    expect(validateSwapApproval({ ...base, pair: v4, expected: permit2, intent: { ...base.intent,
      payloadHash: swapApprovalPayloadHash(permit2) }, transaction: { ...base.transaction, to: permit2.to,
      data: permit2.data } })).toEqual(reject("APPROVAL_CONSTRAINT_INVALID"));
  });
});
