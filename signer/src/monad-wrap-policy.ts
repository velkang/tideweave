import { MONAD_CHAIN_ID, MONAD_TOKENS, wrapPayloadHash, type MonadWrap } from "@tideweave/chain";
import type { Address, Hex } from "viem";
import type { WalletState } from "./policy";

export type WrapIntentKind = "monad_wrap" | "monad_unwrap";
export const isWrapIntentKind = (kind: string): kind is WrapIntentKind => kind === "monad_wrap" || kind === "monad_unwrap";

export type WrapPolicyRequest = {
  now: number;
  emergencyStop: boolean;
  /** Set when an agent asked for it: agents may not wrap or unwrap. */
  automated: boolean;
  wallet: { address: Address; state: WalletState };
  intent: { kind: WrapIntentKind; status: string; expiresAt: number; payloadHash: Hex };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  /** The wrap rebuilt from its stored action and amount. */
  expected: MonadWrap;
  /** Whether the wallet still holds the MON (wrap) or WMON (unwrap) it spends, read just before signing. */
  holdsEnough: boolean;
};

type Decision = { allowed: true; reason: "POLICY_ALLOWED" } | { allowed: false; reason: string };
const reject = (reason: string): Decision => ({ allowed: false, reason });

/**
 * A wrap or unwrap may only call WMON with the stored calldata and value. An unwrap turns WMON back into
 * MON, so like other exits it still runs under the emergency stop and on a paused wallet; a wrap does not.
 */
export function validateWrapIntent(request: WrapPolicyRequest): Decision {
  const { intent, transaction, expected } = request;
  const exit = expected.action === "unwrap";
  if (request.automated) return reject("AUTOMATION_NOT_ALLOWED");
  if (request.emergencyStop && !exit) return reject("EMERGENCY_STOP_ACTIVE");
  if (intent.status !== "pending") return reject("INTENT_NOT_PENDING");
  if (intent.expiresAt <= request.now) return reject("INTENT_EXPIRED");
  if (transaction.chainId !== MONAD_CHAIN_ID || expected.chainId !== MONAD_CHAIN_ID) return reject("CHAIN_NOT_ALLOWED");
  if (request.wallet.state !== "active" && !(exit && request.wallet.state === "paused")) return reject("WALLET_NOT_SIGNABLE");
  if (intent.kind !== `monad_${expected.action}`) return reject("WRAP_KIND_MISMATCH");
  if (transaction.to.toLowerCase() !== MONAD_TOKENS.WMON.toLowerCase() ||
      transaction.to.toLowerCase() !== expected.to.toLowerCase() ||
      transaction.data.toLowerCase() !== expected.data.toLowerCase() || transaction.value !== expected.value) {
    return reject("TRANSACTION_MISMATCH");
  }
  if (wrapPayloadHash(expected) !== intent.payloadHash) return reject("PAYLOAD_HASH_MISMATCH");
  if (!request.holdsEnough) return reject("WRAP_ASSETS_CHANGED");
  return { allowed: true, reason: "POLICY_ALLOWED" };
}
