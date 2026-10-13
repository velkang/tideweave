import { describe, expect, it } from "vitest";
import { buildMonadWithdrawal, monadWithdrawalPayloadHash } from "@tideweave/chain";
import { zeroAddress, type Address } from "viem";
import { validateMonadWithdrawal, type MonadWithdrawalPolicyRequest } from
  "../src/monad-withdrawal-policy";

const now = 2_000_000_000_000;
const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const recipient = "0x3333333333333333333333333333333333333333";
const nonce = `0x${"ab".repeat(32)}` as const;
const signature = `0x${"cd".repeat(65)}` as const;

function fixture(asset: Address = token): MonadWithdrawalPolicyRequest {
  const withdrawal = buildMonadWithdrawal({ wallet, asset, recipient,
    amount: 100n, nonce, expiresAt: BigInt(Math.floor(now / 1000) + 120) });
  return { now, wallet: { address: wallet, state: "paused" },
    intent: { status: "pending", expiresAt: now + 120_000,
      payloadHash: monadWithdrawalPayloadHash(withdrawal, signature) },
    transaction: { chainId: 143, to: withdrawal.to,
      data: withdrawal.data, value: withdrawal.value },
    withdrawal: { transaction: withdrawal, signature, signatureValid: true },
    simulation: { success: true, blockNumber: 50n, latestBlockNumber: 50n } };
}

describe("Monad withdrawal policy", () => {
  it("allows owner-authorized ERC-20 and MON exits while paused", () => {
    expect(validateMonadWithdrawal(fixture())).toMatchObject({ allowed: true });
    expect(validateMonadWithdrawal(fixture(zeroAddress))).toMatchObject({ allowed: true });
  });
  it("rejects target, value, signature, and payload tampering", () => {
    const target = fixture(); target.transaction.to = recipient;
    expect(validateMonadWithdrawal(target)).toMatchObject({ reason: "WITHDRAWAL_CONTEXT_MISMATCH" });
    const value = fixture(); value.transaction.value = 1n;
    expect(validateMonadWithdrawal(value)).toMatchObject({ reason: "WITHDRAWAL_CONTEXT_MISMATCH" });
    const signature = fixture(); signature.withdrawal.signatureValid = false;
    expect(validateMonadWithdrawal(signature)).toMatchObject({ reason: "OWNER_SIGNATURE_INVALID" });
    const hash = fixture(); hash.intent.payloadHash = `0x${"00".repeat(32)}`;
    expect(validateMonadWithdrawal(hash)).toMatchObject({ reason: "PAYLOAD_HASH_MISMATCH" });
  });
  it("rejects stale simulation and expired authorization", () => {
    const stale = fixture(); stale.simulation.latestBlockNumber = 53n;
    expect(validateMonadWithdrawal(stale)).toMatchObject({ reason: "SIMULATION_STALE" });
    const expired = fixture(); expired.withdrawal.transaction.expiresAt = BigInt(now / 1000);
    expect(validateMonadWithdrawal(expired)).toMatchObject({ reason: "WITHDRAWAL_CONTEXT_MISMATCH" });
  });
});
