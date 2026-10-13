import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import { buildMonadWithdrawal, monadWithdrawalPayloadHash } from "@tideweave/chain";
import { evaluateLoadedMainnetIntent, type LoadedMainnetIntent,
  type MainnetAuditClient } from "../src/mainnet-evaluator";

const now = 1_000_000;
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const recipient = "0x3333333333333333333333333333333333333333" as Address;
const nonce = `0x${"ab".repeat(32)}` as const;

function loaded(asset: Address): LoadedMainnetIntent {
  const transaction = buildMonadWithdrawal({ wallet, asset, recipient,
    amount: 100n, nonce, expiresAt: 1_120n });
  return { intentId: "withdrawal-1", kind: "monad_withdrawal", status: "pending",
    expiresAt: now + 120_000,
    payloadHash: monadWithdrawalPayloadHash(transaction),
    wallet: { address: wallet, state: "paused" },
    transaction: { chainId: 143, to: transaction.to,
      data: transaction.data, value: transaction.value },
    monadWithdrawal: { transaction } };
}

const client = { getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
  getBalance: async () => 100_000n, getCode: async () => "0x6000",
  readContract: async () => 1_000n,
  simulateContract: async () => ({ result: true }), call: async () => ({ data: "0x" }),
} as unknown as MainnetAuditClient;

describe("Monad withdrawal live evaluation", () => {
  it("allows ERC-20 and MON sends after live balance and simulation checks, even under emergency stop", async () => {
    for (const asset of [token, zeroAddress]) {
      const result = await evaluateLoadedMainnetIntent({ loaded: loaded(asset),
        client, store: { save: async () => {} }, emergencyStop: true,
        now: () => now });
      expect(result).toMatchObject({ decision: "allowed", reasonCode: "POLICY_ALLOWED" });
    }
  });
  it("rejects a stored transfer target that differs from the requested send", async () => {
    const intent = loaded(token);
    const result = await evaluateLoadedMainnetIntent({
      loaded: { ...intent, transaction: { ...intent.transaction, to: recipient } }, client,
      store: { save: async () => {} }, emergencyStop: false, now: () => now });
    expect(result).toMatchObject({ decision: "rejected", reasonCode: "WITHDRAWAL_CONTEXT_MISMATCH" });
  });
  it("rejects a send started by an automation run", async () => {
    const intent = { ...loaded(token), automation: {} } as unknown as LoadedMainnetIntent;
    const result = await evaluateLoadedMainnetIntent({ loaded: intent, client,
      store: { save: async () => {} }, emergencyStop: false, now: () => now });
    expect(result).toMatchObject({ decision: "rejected", reasonCode: "AUTOMATION_NOT_ALLOWED" });
  });
});
