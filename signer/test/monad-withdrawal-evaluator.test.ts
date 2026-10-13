import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildMonadWithdrawal, monadWithdrawalDomain, monadWithdrawalMessage,
  monadWithdrawalPayloadHash, monadWithdrawalTypes } from "@tideweave/chain";
import { evaluateLoadedMainnetIntent, type LoadedMainnetIntent,
  type MainnetAuditClient } from "../src/mainnet-evaluator";

const now = 1_000_000;
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const recipient = "0x3333333333333333333333333333333333333333" as Address;
const nonce = `0x${"ab".repeat(32)}` as const;

async function loaded(asset: Address): Promise<LoadedMainnetIntent> {
  const owner = privateKeyToAccount(generatePrivateKey());
  const transaction = buildMonadWithdrawal({ wallet, asset, recipient,
    amount: 100n, nonce, expiresAt: 1_120n });
  const signature = await owner.signTypedData({ domain: monadWithdrawalDomain,
    types: monadWithdrawalTypes, primaryType: "MonadWithdrawal",
    message: monadWithdrawalMessage(transaction) });
  return { intentId: "withdrawal-1", kind: "monad_withdrawal", status: "pending",
    expiresAt: now + 120_000,
    payloadHash: monadWithdrawalPayloadHash(transaction, signature),
    wallet: { address: wallet, state: "paused" },
    transaction: { chainId: 143, to: transaction.to,
      data: transaction.data, value: transaction.value },
    monadWithdrawal: { transaction, ownerAddress: owner.address, signature } };
}

const client = { getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
  getBalance: async () => 100_000n, getCode: async () => "0x6000",
  readContract: async () => 1_000n,
  simulateContract: async () => ({ result: true }), call: async () => ({ data: "0x" }),
} as unknown as MainnetAuditClient;

describe("Monad withdrawal live evaluation", () => {
  it("allows signed ERC-20 and MON exits after live balance and simulation checks", async () => {
    for (const asset of [token, zeroAddress]) {
      const result = await evaluateLoadedMainnetIntent({ loaded: await loaded(asset),
        client, store: { save: async () => {} }, emergencyStop: true,
        now: () => now });
      expect(result).toMatchObject({ decision: "allowed", reasonCode: "POLICY_ALLOWED" });
    }
  });
  it("rejects a stored transfer target that differs from the owner's authorization", async () => {
    const intent = await loaded(token);
    intent.transaction.to = recipient;
    const result = await evaluateLoadedMainnetIntent({ loaded: intent, client,
      store: { save: async () => {} }, emergencyStop: false, now: () => now });
    expect(result).toMatchObject({ decision: "rejected", reasonCode: "WITHDRAWAL_CONTEXT_MISMATCH" });
  });
});
