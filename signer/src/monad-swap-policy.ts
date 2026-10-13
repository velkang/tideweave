import { MAX_SWAP_PRICE_IMPACT_BPS, MONAD_CHAIN_ID, monadSwapPayloadHash, swapApprovalPayloadHash, swapSpender,
  type MonadSwap, type SwapApproval, type SwapPair } from "@tideweave/chain";
import { zeroAddress, type Address, type Hex } from "viem";
import type { WalletState } from "./policy";

export const isSwapIntentKind = (kind: string): kind is "monad_swap" | "monad_swap_approval" =>
  kind === "monad_swap" || kind === "monad_swap_approval";

type Common = {
  now: number;
  emergencyStop: boolean;
  wallet: { address: Address; state: WalletState };
  intent: { status: string; expiresAt: number; payloadHash: Hex };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  /** The pair read live. */
  pair: SwapPair;
  simulation: { success: boolean; blockNumber: bigint; latestBlockNumber: bigint };
};
export type SwapPolicyRequest = Common & {
  /** The swap rebuilt from its stored request. */
  expected: MonadSwap;
  /** The pool's answer for the same swap just before signing. */
  live: { amountOut: bigint; priceImpactBps: number; almostEmpty: boolean };
};
export type SwapApprovalPolicyRequest = Common & { expected: SwapApproval };

type Decision = { allowed: true; reason: "POLICY_ALLOWED" } | { allowed: false; reason: string };
const allowed: Decision = { allowed: true, reason: "POLICY_ALLOWED" };
const reject = (reason: string): Decision => ({ allowed: false, reason });
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
const THREE_DAYS = 3n * 24n * 60n * 60n;

/** Swaps and their approvals add exposure, so both stop under the emergency stop and while paused. */
function checkCommon(request: Common, expected: { chainId: number; to: Address; data: Hex }): Decision | null {
  const { intent, transaction, simulation } = request;
  if (request.emergencyStop) return reject("EMERGENCY_STOP_ACTIVE");
  if (intent.status !== "pending") return reject("INTENT_NOT_PENDING");
  if (intent.expiresAt <= request.now) return reject("INTENT_EXPIRED");
  if (transaction.chainId !== MONAD_CHAIN_ID || expected.chainId !== MONAD_CHAIN_ID) return reject("CHAIN_NOT_ALLOWED");
  if (request.wallet.state !== "active") return reject("WALLET_NOT_SIGNABLE");
  if (!simulation.success) return reject("SIMULATION_FAILED");
  if (simulation.latestBlockNumber < simulation.blockNumber ||
      simulation.latestBlockNumber - simulation.blockNumber > 2n) return reject("SIMULATION_STALE");
  if (!same(transaction.to, expected.to) || transaction.data.toLowerCase() !== expected.data.toLowerCase()) {
    return reject("TRANSACTION_MISMATCH");
  }
  return null;
}

/**
 * A swap is signed only as rebuilt from its request, paying the wallet before a deadline at most
 * 30 minutes away, and only while the pool still gives at least the stored minimum without more
 * than 5% price impact. Value is allowed only for native MON sold into a v4 pool.
 */
export function validateSwapIntent(request: SwapPolicyRequest): Decision {
  const { expected, pair, live, transaction } = request;
  const common = checkCommon(request, expected);
  if (common) return common;
  const nativeIn = pair.venue === "uniswap-v4" && expected.tokenIn === zeroAddress;
  const allowedValue = nativeIn ? expected.amountIn : 0n;
  if (transaction.value !== allowedValue || expected.value !== allowedValue) return reject("NATIVE_VALUE_NOT_ALLOWED");
  const seconds = BigInt(Math.floor(request.now / 1_000));
  if (expected.venue !== pair.venue || expected.pairId.toLowerCase() !== pair.id.toLowerCase() ||
      !same(expected.recipient, request.wallet.address) || expected.amountIn <= 0n || expected.amountOutMinimum <= 0n ||
      expected.deadline <= seconds || expected.deadline > seconds + 1_800n) return reject("SWAP_CONSTRAINT_INVALID");
  if (live.almostEmpty) return reject("POOL_ALMOST_EMPTY");
  if (live.priceImpactBps > MAX_SWAP_PRICE_IMPACT_BPS) return reject("PRICE_IMPACT_TOO_HIGH");
  if (live.amountOut < expected.amountOutMinimum) return reject("MINIMUM_NO_LONGER_MET");
  return monadSwapPayloadHash(expected) === request.intent.payloadHash ? allowed : reject("PAYLOAD_HASH_MISMATCH");
}

/** An approval is signed only for a pair token, to the venue's own spender, and Permit2 for at most three days. */
export function validateSwapApproval(request: SwapApprovalPolicyRequest): Decision {
  const { expected, pair } = request;
  const common = checkCommon(request, expected);
  if (common) return common;
  if (request.transaction.value !== 0n || expected.value !== 0n) return reject("NATIVE_VALUE_NOT_ALLOWED");
  const spenders = swapSpender(pair.venue);
  const seconds = BigInt(Math.floor(request.now / 1_000));
  const token = expected.token.toLowerCase();
  const inPair = [pair.token0.address, pair.token1.address].some((address) => address.toLowerCase() === token);
  const spenderValid = expected.stage === "erc20" ? same(expected.spender, spenders.erc20Spender)
    : spenders.permit2Spender !== null && same(expected.spender, spenders.permit2Spender) &&
      expected.expiration > seconds && expected.expiration <= seconds + THREE_DAYS;
  if (expected.venue !== pair.venue || !inPair || token === zeroAddress || !spenderValid || expected.amount <= 0n) {
    return reject("APPROVAL_CONSTRAINT_INVALID");
  }
  return swapApprovalPayloadHash(expected) === request.intent.payloadHash ? allowed : reject("PAYLOAD_HASH_MISMATCH");
}
