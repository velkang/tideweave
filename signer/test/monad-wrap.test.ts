import { getAddress, parseAbi, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, buildWrap, wrapPayloadHash } from "@tideweave/chain";
import { evaluateLoadedMainnetIntent, type LoadedMainnetIntent, type MainnetAuditClient } from "../src/mainnet-evaluator";
import { validateWrapIntent, type WrapPolicyRequest } from "../src/monad-wrap-policy";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const now = 1_000_000_000;
const ONE = 10n ** 18n;
const wrap = buildWrap({ action: "wrap", amount: ONE });
const unwrap = buildWrap({ action: "unwrap", amount: ONE });

function request(overrides: Partial<WrapPolicyRequest> = {}): WrapPolicyRequest {
  const expected = overrides.expected ?? wrap;
  return { now, emergencyStop: false, automated: false, wallet: { address: wallet, state: "active" },
    intent: { kind: expected.action === "wrap" ? "monad_wrap" : "monad_unwrap", status: "pending",
      expiresAt: now + 60_000, payloadHash: wrapPayloadHash(expected) },
    transaction: { chainId: 143, to: expected.to, data: expected.data, value: expected.value },
    expected, holdsEnough: true, ...overrides };
}
const reject = (reason: string) => ({ allowed: false, reason });

describe("wrap signer policy", () => {
  it("allows the exact wrap or unwrap", () => {
    expect(validateWrapIntent(request()).allowed).toBe(true);
    expect(validateWrapIntent(request({ expected: unwrap })).allowed).toBe(true);
  });

  it("refuses anything but WMON, the stored calldata and the stored value", () => {
    expect(validateWrapIntent(request({ transaction: { chainId: 143, to: MONAD_TOKENS.USDC, data: wrap.data, value: ONE } })))
      .toEqual(reject("TRANSACTION_MISMATCH"));
    expect(validateWrapIntent(request({ transaction: { chainId: 143, to: wrap.to, data: wrap.data, value: ONE + 1n } })))
      .toEqual(reject("TRANSACTION_MISMATCH"));
    expect(validateWrapIntent(request({ expected: unwrap,
      transaction: { chainId: 143, to: unwrap.to, data: unwrap.data, value: 1n } }))).toEqual(reject("TRANSACTION_MISMATCH"));
    expect(validateWrapIntent(request({ intent: { ...request().intent, payloadHash: wrapPayloadHash(unwrap) } })))
      .toEqual(reject("PAYLOAD_HASH_MISMATCH"));
    expect(validateWrapIntent(request({ intent: { ...request().intent, kind: "monad_unwrap" } })))
      .toEqual(reject("WRAP_KIND_MISMATCH"));
  });

  it("stops wraps but lets unwraps out under the emergency stop or a paused wallet", () => {
    expect(validateWrapIntent(request({ emergencyStop: true }))).toEqual(reject("EMERGENCY_STOP_ACTIVE"));
    expect(validateWrapIntent(request({ expected: unwrap, emergencyStop: true })).allowed).toBe(true);
    expect(validateWrapIntent(request({ wallet: { address: wallet, state: "paused" } }))).toEqual(reject("WALLET_NOT_SIGNABLE"));
    expect(validateWrapIntent(request({ expected: unwrap, wallet: { address: wallet, state: "paused" } })).allowed).toBe(true);
  });

  it("refuses an agent, a stale intent, or a wallet that no longer holds enough", () => {
    expect(validateWrapIntent(request({ automated: true }))).toEqual(reject("AUTOMATION_NOT_ALLOWED"));
    expect(validateWrapIntent(request({ intent: { ...request().intent, expiresAt: now } }))).toEqual(reject("INTENT_EXPIRED"));
    expect(validateWrapIntent(request({ intent: { ...request().intent, status: "submitted" } })))
      .toEqual(reject("INTENT_NOT_PENDING"));
    expect(validateWrapIntent(request({ holdsEnough: false }))).toEqual(reject("WRAP_ASSETS_CHANGED"));
  });
});

describe("evaluating a stored wrap against the chain", () => {
  const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
  function loaded(action: "wrap" | "unwrap"): LoadedMainnetIntent {
    const built = action === "wrap" ? wrap : unwrap;
    return { intentId: `monad_${action}_1`, kind: `monad_${action}`, status: "pending", expiresAt: now + 60_000,
      payloadHash: wrapPayloadHash(built), wallet: { address: wallet, state: "active" },
      transaction: { chainId: 143, to: built.to, data: built.data, value: built.value },
      monadWrap: { action, amount: ONE } };
  }
  const client = (mon: bigint, wmon: bigint) => ({
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getBalance: async () => mon,
    call: async () => ({ data: "0x" }),
    readContract: async ({ address, abi }: { address: Address; abi: typeof balanceAbi }) => {
      expect(address).toBe(MONAD_TOKENS.WMON);
      expect(abi).toBeDefined();
      return wmon;
    },
  }) as unknown as MainnetAuditClient;
  const run = (intent: LoadedMainnetIntent, mon: bigint, wmon: bigint) => evaluateLoadedMainnetIntent({ loaded: intent,
    client: client(mon, wmon), store: { save: async () => {} }, emergencyStop: false, now: () => now });

  it("allows a wrap the wallet's MON covers and an unwrap its WMON covers", async () => {
    expect(await run(loaded("wrap"), 2n * ONE, 0n)).toMatchObject({ decision: "allowed" });
    expect(await run(loaded("unwrap"), 0n, ONE)).toMatchObject({ decision: "allowed" });
  });

  it("refuses when the balance has gone", async () => {
    expect(await run(loaded("wrap"), ONE - 1n, 0n)).toMatchObject({ decision: "rejected", reasonCode: "WRAP_ASSETS_CHANGED" });
    expect(await run(loaded("unwrap"), 5n * ONE, ONE - 1n))
      .toMatchObject({ decision: "rejected", reasonCode: "WRAP_ASSETS_CHANGED" });
  });
});
