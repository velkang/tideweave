import { MONAD_CHAIN_ID, SIMPLE_7702_ACCOUNT, nadBatchPayloadHash, type MonadNadPair, type NadAdd,
  type NadDelegationClear, type NadRemove } from "@tideweave/chain";
import { zeroAddress, type Address, type Hex } from "viem";
import type { WalletState } from "./policy";

const kinds = ["monad_nadfun_add", "monad_nadfun_remove", "monad_delegation_clear"] as const;
export type NadIntentKind = typeof kinds[number];
export const isNadIntentKind = (kind: string): kind is NadIntentKind => (kinds as readonly string[]).includes(kind);

/** The contract the wallet must delegate to while this kind runs: the batch account, or none. */
export const delegationFor = (kind: NadIntentKind): Address =>
  kind === "monad_delegation_clear" ? zeroAddress : SIMPLE_7702_ACCOUNT;

export type NadPolicyRequest = {
  now: number;
  emergencyStop: boolean;
  wallet: { address: Address; state: WalletState };
  intent: { kind: NadIntentKind; status: string; expiresAt: number; payloadHash: Hex };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  /** The pair read live; absent for a delegation clear. */
  pair?: MonadNadPair;
  /** The batch rebuilt from the stored preview. */
  expected: NadAdd | NadRemove | NadDelegationClear;
  /** The wallet's current EIP-7702 delegate, or null when it has none. */
  delegate: Address | null;
  simulation: { success: boolean; blockNumber: bigint; latestBlockNumber: bigint };
};

type Decision = { allowed: true; reason: "POLICY_ALLOWED" } | { allowed: false; reason: string };
const allowed: Decision = { allowed: true, reason: "POLICY_ALLOWED" };
const reject = (reason: string): Decision => ({ allowed: false, reason });
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

function checkShape(request: NadPolicyRequest): Decision | null {
  const { intent, expected, pair } = request;
  if (intent.kind === "monad_delegation_clear") {
    if (expected.kind !== "clear" || expected.delegate !== zeroAddress || expected.data !== "0x") {
      return reject("CLEAR_CONSTRAINT_INVALID");
    }
    return request.delegate === null ? reject("NOT_DELEGATED") : null;
  }
  if (!pair || expected.kind === "clear") return reject("PAIR_CONTEXT_MISSING");
  if ((intent.kind === "monad_nadfun_add") !== (expected.kind === "add")) return reject("INTENT_KIND_MISMATCH");
  if (!same(expected.pair, pair.id)) return reject("PAIR_MISMATCH");
  if (request.delegate !== null && !same(request.delegate, SIMPLE_7702_ACCOUNT)) {
    return reject("DELEGATION_UNEXPECTED");
  }
  if (expected.kind === "add" && (expected.amount0 <= 0n || expected.amount1 <= 0n || expected.minLiquidity <= 0n)) {
    return reject("ADD_CONSTRAINT_INVALID");
  }
  if (expected.kind === "remove" && expected.liquidity <= 0n) return reject("REMOVE_CONSTRAINT_INVALID");
  return null;
}

/**
 * A nad.fun batch is signed only as the exact template rebuilt from its preview: sent by the
 * wallet to itself, with no value, for the previewed pair, while the wallet is delegated to
 * nothing or to Simple7702Account. Deposits stop under the emergency stop; exits do not.
 */
export function validateNadIntent(request: NadPolicyRequest): Decision {
  const { intent, transaction, wallet, expected, simulation } = request;
  const deposit = intent.kind === "monad_nadfun_add";
  if (request.emergencyStop && deposit) return reject("EMERGENCY_STOP_ACTIVE");
  if (intent.status !== "pending") return reject("INTENT_NOT_PENDING");
  if (intent.expiresAt <= request.now) return reject("INTENT_EXPIRED");
  if (transaction.chainId !== MONAD_CHAIN_ID || expected.chainId !== MONAD_CHAIN_ID) return reject("CHAIN_NOT_ALLOWED");
  if (transaction.value !== 0n || expected.value !== 0n) return reject("NATIVE_VALUE_NOT_ALLOWED");
  if (wallet.state !== "active" && !(!deposit && wallet.state === "paused")) return reject("WALLET_NOT_SIGNABLE");
  if (!simulation.success) return reject("SIMULATION_FAILED");
  if (simulation.latestBlockNumber < simulation.blockNumber ||
      simulation.latestBlockNumber - simulation.blockNumber > 2n) return reject("SIMULATION_STALE");
  if (!same(transaction.to, wallet.address) || !same(expected.to, wallet.address) ||
      transaction.data.toLowerCase() !== expected.data.toLowerCase()) return reject("TRANSACTION_MISMATCH");
  const shape = checkShape(request);
  if (shape) return shape;
  return nadBatchPayloadHash(expected) === intent.payloadHash ? allowed : reject("PAYLOAD_HASH_MISMATCH");
}
