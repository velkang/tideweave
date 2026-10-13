import { MONAD_CHAIN_ID, monadWithdrawalPayloadHash, type MonadWithdrawal } from "@tideweave/chain";
import { zeroAddress, type Address, type Hex } from "viem";
import type { WalletState } from "./policy";

export type MonadWithdrawalPolicyRequest = {
  now: number;
  wallet: { address: Address; state: WalletState };
  intent: { status: string; expiresAt: number; payloadHash: Hex };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  withdrawal: { transaction: MonadWithdrawal; signature: Hex; signatureValid: boolean };
  simulation: { success: boolean; blockNumber: bigint; latestBlockNumber: bigint };
};

export function validateMonadWithdrawal(request: MonadWithdrawalPolicyRequest):
  { allowed: true; reason: "POLICY_ALLOWED" } | { allowed: false; reason: string } {
  const reject = (reason: string) => ({ allowed: false as const, reason });
  if (request.intent.status !== "pending") return reject("INTENT_NOT_PENDING");
  if (request.intent.expiresAt <= request.now) return reject("INTENT_EXPIRED");
  if (request.wallet.state !== "active" && request.wallet.state !== "paused") {
    return reject("WALLET_NOT_SIGNABLE");
  }
  if (request.transaction.chainId !== MONAD_CHAIN_ID ||
      request.withdrawal.transaction.chainId !== MONAD_CHAIN_ID) return reject("CHAIN_NOT_ALLOWED");
  if (!request.simulation.success) return reject("SIMULATION_FAILED");
  if (request.simulation.latestBlockNumber < request.simulation.blockNumber ||
      request.simulation.latestBlockNumber - request.simulation.blockNumber > 2n) {
    return reject("SIMULATION_STALE");
  }
  if (!request.withdrawal.signatureValid) return reject("OWNER_SIGNATURE_INVALID");
  const withdrawal = request.withdrawal.transaction;
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
  if (!same(withdrawal.wallet, request.wallet.address) ||
      withdrawal.recipient === zeroAddress || same(withdrawal.recipient, withdrawal.wallet) ||
      withdrawal.amount <= 0n ||
      withdrawal.expiresAt <= BigInt(Math.floor(request.now / 1_000)) ||
      !same(request.transaction.to, withdrawal.to) ||
      request.transaction.data !== withdrawal.data ||
      request.transaction.value !== withdrawal.value ||
      (withdrawal.asset === zeroAddress &&
        (request.transaction.data !== "0x" || request.transaction.value !== withdrawal.amount)) ||
      (withdrawal.asset !== zeroAddress &&
        (!same(withdrawal.to, withdrawal.asset) || request.transaction.value !== 0n))) {
    return reject("WITHDRAWAL_CONTEXT_MISMATCH");
  }
  return monadWithdrawalPayloadHash(withdrawal, request.withdrawal.signature) ===
      request.intent.payloadHash
    ? { allowed: true, reason: "POLICY_ALLOWED" }
    : reject("PAYLOAD_HASH_MISMATCH");
}
