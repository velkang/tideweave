import { getAddress, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, SIMPLE_7702_ACCOUNT, buildNadAdd, buildNadDelegationClear, buildNadRemove,
  nadBatchPayloadHash, type MonadNadPair } from "@tideweave/chain";
import { validateNadIntent, type NadPolicyRequest } from "../src/monad-nadfun-policy";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const meme = getAddress("0x7777777777777777777777777777777777777777");
const pair: MonadNadPair = { chainId: MONAD_CHAIN_ID, venue: "nadfun-v2",
  id: getAddress("0x4444444444444444444444444444444444444444"), memeToken: meme,
  token0: { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18 },
  token1: { address: meme, symbol: "MEME", decimals: 18 },
  reserve0: 4_000n * 10n ** 18n, reserve1: 2_000_000n * 10n ** 18n, totalSupply: 1_000_000n * 10n ** 18n };
const add = buildNadAdd({ pair, wallet, amount0Desired: 10n ** 19n, amount1Desired: 10n ** 22n, slippageBps: 100,
  lpBefore: 0n });
const remove = buildNadRemove({ pair, wallet, liquidity: 10n ** 21n, slippageBps: 100, balance0Before: 0n,
  balance1Before: 0n });
const clear = buildNadDelegationClear({ wallet });

function request(kind: NadPolicyRequest["intent"]["kind"], expected: NadPolicyRequest["expected"],
  overrides: Partial<NadPolicyRequest> = {}): NadPolicyRequest {
  return { now: 1_000_000, emergencyStop: false, wallet: { address: wallet, state: "active" },
    intent: { kind, status: "pending", expiresAt: 1_100_000, payloadHash: nadBatchPayloadHash(expected) },
    transaction: { chainId: 143, to: wallet, data: expected.data, value: 0n },
    pair: kind === "monad_delegation_clear" ? undefined : pair, expected,
    delegate: kind === "monad_delegation_clear" ? SIMPLE_7702_ACCOUNT : null,
    simulation: { success: true, blockNumber: 100n, latestBlockNumber: 101n }, ...overrides };
}
const reject = (reason: string) => ({ allowed: false, reason });

describe("nad.fun signer policy", () => {
  it("allows an add, a remove and a delegation clear that match their templates", () => {
    expect(validateNadIntent(request("monad_nadfun_add", add)).allowed).toBe(true);
    expect(validateNadIntent(request("monad_nadfun_remove", remove)).allowed).toBe(true);
    expect(validateNadIntent(request("monad_delegation_clear", clear)).allowed).toBe(true);
  });

  it("only signs a batch the wallet sends to itself, with no value and its exact calldata", () => {
    const valid = request("monad_nadfun_add", add);
    expect(validateNadIntent({ ...valid, transaction: { ...valid.transaction, to: meme } }))
      .toEqual(reject("TRANSACTION_MISMATCH"));
    expect(validateNadIntent({ ...valid, transaction: { ...valid.transaction, data: remove.data } }))
      .toEqual(reject("TRANSACTION_MISMATCH"));
    expect(validateNadIntent({ ...valid, transaction: { ...valid.transaction, value: 1n } }))
      .toEqual(reject("NATIVE_VALUE_NOT_ALLOWED"));
    expect(validateNadIntent({ ...valid, intent: { ...valid.intent, payloadHash: `0x${"00".repeat(32)}` as Hex } }))
      .toEqual(reject("PAYLOAD_HASH_MISMATCH"));
  });

  it("refuses a batch for another pair or another wallet", () => {
    const valid = request("monad_nadfun_add", add);
    expect(validateNadIntent({ ...valid, pair: { ...pair, id: meme } })).toEqual(reject("PAIR_MISMATCH"));
    expect(validateNadIntent({ ...valid, wallet: { ...valid.wallet, address: meme } }))
      .toEqual(reject("TRANSACTION_MISMATCH"));
  });

  it("stops deposits but not exits during an emergency stop or while paused", () => {
    expect(validateNadIntent(request("monad_nadfun_add", add, { emergencyStop: true })))
      .toEqual(reject("EMERGENCY_STOP_ACTIVE"));
    expect(validateNadIntent(request("monad_nadfun_remove", remove, { emergencyStop: true })).allowed).toBe(true);
    expect(validateNadIntent(request("monad_delegation_clear", clear, { emergencyStop: true })).allowed).toBe(true);
    const paused = { address: wallet, state: "paused" as const };
    expect(validateNadIntent(request("monad_nadfun_add", add, { wallet: paused }))).toEqual(reject("WALLET_NOT_SIGNABLE"));
    expect(validateNadIntent(request("monad_nadfun_remove", remove, { wallet: paused })).allowed).toBe(true);
  });

  it("refuses a wallet delegated to anything but Simple7702Account, and a clear with nothing to clear", () => {
    expect(validateNadIntent(request("monad_nadfun_add", add, { delegate: meme })))
      .toEqual(reject("DELEGATION_UNEXPECTED"));
    expect(validateNadIntent(request("monad_nadfun_add", add, { delegate: SIMPLE_7702_ACCOUNT })).allowed).toBe(true);
    expect(validateNadIntent(request("monad_delegation_clear", clear, { delegate: null })))
      .toEqual(reject("NOT_DELEGATED"));
  });

  it("refuses stale simulations and spent or expired intents", () => {
    expect(validateNadIntent(request("monad_nadfun_add", add, { simulation: { success: true, blockNumber: 100n,
      latestBlockNumber: 110n } }))).toEqual(reject("SIMULATION_STALE"));
    expect(validateNadIntent(request("monad_nadfun_add", add, { simulation: { success: false, blockNumber: 100n,
      latestBlockNumber: 100n } }))).toEqual(reject("SIMULATION_FAILED"));
    const valid = request("monad_nadfun_add", add);
    expect(validateNadIntent({ ...valid, intent: { ...valid.intent, status: "confirmed" } }))
      .toEqual(reject("INTENT_NOT_PENDING"));
    expect(validateNadIntent({ ...valid, now: 1_200_000 })).toEqual(reject("INTENT_EXPIRED"));
  });

  it("refuses a clear whose calldata is not empty", () => {
    const valid = request("monad_delegation_clear", clear);
    expect(validateNadIntent({ ...valid, transaction: { ...valid.transaction, data: add.data } }))
      .toEqual(reject("TRANSACTION_MISMATCH"));
    expect(validateNadIntent({ ...valid, expected: { ...clear, delegate: SIMPLE_7702_ACCOUNT as typeof zeroAddress } }))
      .toEqual(reject("CLEAR_CONSTRAINT_INVALID"));
  });
});
