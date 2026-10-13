import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, buildMonadV4Approval, buildMonadV4Mint,
  buildMonadV4PositionAction, monadV4ApprovalPayloadHash,
  monadV4MintPayloadHash, monadV4PoolId,
  monadV4PositionActionPayloadHash, type MonadV4Pool } from "@tideweave/chain";
import { validateMonadV4Intent, type MonadV4PolicyRequest } from "../src/monad-v4-policy";

const owner = getAddress("0x4444444444444444444444444444444444444444");
const currency0 = getAddress("0x1111111111111111111111111111111111111111");
const currency1 = getAddress("0x2222222222222222222222222222222222222222");
const key = { currency0, currency1, fee: 500, tickSpacing: 10,
  hooks: zeroAddress };
const pool: MonadV4Pool = { ...key, id: monadV4PoolId(key),
  chainId: MONAD_CHAIN_ID, venue: "uniswap-v4",
  token0: { address: currency0, symbol: "A", decimals: 6 },
  token1: { address: currency1, symbol: "B", decimals: 24 },
  sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000_000n,
  lpFee: 500 };
const request = (kind: MonadV4PolicyRequest["intent"]["kind"],
  expected: MonadV4PolicyRequest["expected"], payloadHash: `0x${string}`): MonadV4PolicyRequest => ({
  now: 1_000_000, emergencyStop: false,
  wallet: { address: owner, state: "active" },
  intent: { kind, status: "pending", expiresAt: 1_100_000, payloadHash },
  transaction: { chainId: 143, to: expected.to, data: expected.data, value: 0n },
  pool, expected,
  simulation: { success: true, blockNumber: 100n, latestBlockNumber: 101n },
});

describe("Monad v4 signer policy", () => {
  it("allows bounded two-stage approvals and rejects wrong calldata", () => {
    const approval = buildMonadV4Approval({ pool, token: currency1,
      stage: "permit2", amount: 100n, expiration: 1_600n });
    const valid = request("monad_v4_approval", approval,
      monadV4ApprovalPayloadHash(approval));
    expect(validateMonadV4Intent(valid).allowed).toBe(true);
    expect(validateMonadV4Intent({ ...valid, transaction: {
      ...valid.transaction, to: owner } })).toEqual({ allowed: false,
      reason: "TRANSACTION_MISMATCH" });
    expect(validateMonadV4Intent({ ...valid, expected: { ...approval,
      expiration: 1_000n } })).toEqual({ allowed: false,
      reason: "APPROVAL_CONSTRAINT_INVALID" });
  });

  it("allows a budgeted two-token mint only in its canonical pair", () => {
    const mint = buildMonadV4Mint({ pool, recipient: owner,
      tickLower: -100, tickUpper: 100, amount0Desired: 1_000_000_000n,
      amount1Desired: 1_000_000_000_000_000_000_000n,
      slippageBps: 100, deadline: 1_600n });
    const valid = request("monad_v4_mint", mint, monadV4MintPayloadHash(mint));
    expect(validateMonadV4Intent(valid).allowed).toBe(true);
    expect(validateMonadV4Intent({ ...valid, pool: { ...pool, fee: 3_000 } }))
      .toEqual({ allowed: false, reason: "POOL_NOT_CANONICAL" });
    expect(validateMonadV4Intent({ ...valid, transaction: {
      ...valid.transaction, chainId: 1 } }))
      .toEqual({ allowed: false, reason: "CHAIN_NOT_ALLOWED" });
  });

  it("allows an owned full exit during emergency stop and rejects stale intents", () => {
    const position = { tokenId: 7n, pool, tickLower: -100,
      tickUpper: 100, liquidity: 100n };
    const action = buildMonadV4PositionAction({ kind: "withdraw", position,
      recipient: owner, slippageBps: 100, deadline: 1_600n });
    const valid = { ...request("monad_v4_position_withdraw", action,
      monadV4PositionActionPayloadHash(action)), emergencyStop: true };
    expect(validateMonadV4Intent(valid).allowed).toBe(true);
    expect(validateMonadV4Intent({ ...valid, simulation: { success: true,
      blockNumber: 100n, latestBlockNumber: 103n } }))
      .toEqual({ allowed: false, reason: "SIMULATION_STALE" });
    expect(validateMonadV4Intent({ ...valid, intent: { ...valid.intent,
      status: "submitted" } })).toEqual({ allowed: false, reason: "INTENT_NOT_PENDING" });
  });

  it("allows a partial removal as an exit, and only as the kind it was stored as", () => {
    const position = { tokenId: 7n, pool, tickLower: -100, tickUpper: 100, liquidity: 100n };
    const action = buildMonadV4PositionAction({ kind: "decrease", removeBps: 2_500, position,
      recipient: owner, slippageBps: 100, deadline: 1_600n });
    const valid = { ...request("monad_v4_position_decrease", action,
      monadV4PositionActionPayloadHash(action)), emergencyStop: true };
    expect(validateMonadV4Intent(valid).allowed).toBe(true);
    expect(validateMonadV4Intent({ ...valid, intent: { ...valid.intent, kind: "monad_v4_position_withdraw" } }))
      .toEqual({ allowed: false, reason: "POSITION_CONSTRAINT_INVALID" });
  });

  it("allows MON as value only for a native-pool mint, and only its exact budget", () => {
    const nativeKey = { ...key, currency0: zeroAddress };
    const nativePool: MonadV4Pool = { ...pool, ...nativeKey, id: monadV4PoolId(nativeKey),
      token0: { address: zeroAddress, symbol: "MON", decimals: 18 } };
    const mint = buildMonadV4Mint({ pool: nativePool, recipient: owner, tickLower: -100, tickUpper: 100,
      amount0Desired: 10n ** 18n, amount1Desired: 10n ** 24n, slippageBps: 100, deadline: 1_600n });
    const base = request("monad_v4_mint", mint, monadV4MintPayloadHash(mint));
    const valid = { ...base, pool: nativePool, transaction: { ...base.transaction, value: mint.value } };
    expect(mint.value).toBeGreaterThan(0n);
    expect(validateMonadV4Intent(valid).allowed).toBe(true);
    expect(validateMonadV4Intent({ ...valid, transaction: { ...valid.transaction, value: mint.value + 1n } }))
      .toEqual({ allowed: false, reason: "NATIVE_VALUE_NOT_ALLOWED" });
    expect(validateMonadV4Intent({ ...valid, expected: { ...mint, value: mint.amount0Max + 1n },
      transaction: { ...valid.transaction, value: mint.amount0Max + 1n } }))
      .toEqual({ allowed: false, reason: "NATIVE_VALUE_NOT_ALLOWED" });
  });

  it("still refuses value on an ERC-20 pool mint or any exit", () => {
    const mint = buildMonadV4Mint({ pool, recipient: owner, tickLower: -100, tickUpper: 100,
      amount0Desired: 1_000_000_000n, amount1Desired: 10n ** 24n, slippageBps: 100, deadline: 1_600n });
    const valid = request("monad_v4_mint", mint, monadV4MintPayloadHash(mint));
    expect(validateMonadV4Intent({ ...valid, transaction: { ...valid.transaction, value: 1n } }))
      .toEqual({ allowed: false, reason: "NATIVE_VALUE_NOT_ALLOWED" });
  });
});

