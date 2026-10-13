import { MONAD_CHAIN_ID, UNISWAP_V4_MONAD, monadV4PoolId,
  monadV4ApprovalPayloadHash, monadV4MintPayloadHash,
  monadV4PositionActionPayloadHash,
  type MonadV4Approval, type MonadV4Mint, type MonadV4Pool,
  type MonadV4PositionAction } from "@tideweave/chain";
import { zeroAddress, type Address, type Hex } from "viem";
import type { WalletState } from "./policy";

const kinds = ["monad_v4_approval", "monad_v4_mint",
  "monad_v4_position_collect", "monad_v4_position_decrease", "monad_v4_position_withdraw"] as const;
export type MonadV4IntentKind = typeof kinds[number];
export const isMonadV4IntentKind = (kind: string): kind is MonadV4IntentKind =>
  (kinds as readonly string[]).includes(kind);

export type MonadV4PolicyRequest = {
  now: number;
  emergencyStop: boolean;
  wallet: { address: Address; state: WalletState };
  intent: { kind: MonadV4IntentKind; status: string; expiresAt: number; payloadHash: Hex };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  pool: MonadV4Pool;
  expected: MonadV4Approval | MonadV4Mint | MonadV4PositionAction;
  simulation: { success: boolean; blockNumber: bigint; latestBlockNumber: bigint };
};

type Decision = { allowed: true; reason: "POLICY_ALLOWED" } |
  { allowed: false; reason: string };
const allowed: Decision = { allowed: true, reason: "POLICY_ALLOWED" };
const reject = (reason: string): Decision => ({ allowed: false, reason });
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

export function validateMonadV4Intent(request: MonadV4PolicyRequest): Decision {
  const { intent, transaction, wallet, expected, pool, simulation } = request;
  const exit = intent.kind === "monad_v4_position_collect" || intent.kind === "monad_v4_position_decrease" ||
    intent.kind === "monad_v4_position_withdraw";
  if (request.emergencyStop && !exit) return reject("EMERGENCY_STOP_ACTIVE");
  if (intent.status !== "pending") return reject("INTENT_NOT_PENDING");
  if (intent.expiresAt <= request.now) return reject("INTENT_EXPIRED");
  if (transaction.chainId !== MONAD_CHAIN_ID || pool.chainId !== MONAD_CHAIN_ID ||
      expected.chainId !== MONAD_CHAIN_ID) return reject("CHAIN_NOT_ALLOWED");
  // Only a mint into a native-MON pool sends value, and exactly its MON budget (amount0Max).
  const nativeMint = intent.kind === "monad_v4_mint" && pool.currency0 === zeroAddress &&
    "amount0Max" in expected;
  const allowedValue = nativeMint ? expected.amount0Max : 0n;
  if (transaction.value !== allowedValue || expected.value !== allowedValue) {
    return reject("NATIVE_VALUE_NOT_ALLOWED");
  }
  if (wallet.state !== "active" && !(exit && wallet.state === "paused")) {
    return reject("WALLET_NOT_SIGNABLE");
  }
  if (!simulation.success) return reject("SIMULATION_FAILED");
  if (simulation.latestBlockNumber < simulation.blockNumber ||
      simulation.latestBlockNumber - simulation.blockNumber > 2n) {
    return reject("SIMULATION_STALE");
  }
  try {
    if (monadV4PoolId(pool) !== pool.id) return reject("POOL_NOT_CANONICAL");
  } catch { return reject("POOL_NOT_CANONICAL"); }
  if (!exit && (pool.sqrtPriceX96 <= 0n || pool.liquidity <= 0n)) {
    return reject("POOL_NOT_ACTIVE");
  }
  if (expected.poolId.toLowerCase() !== pool.id.toLowerCase()) {
    return reject("POOL_ID_MISMATCH");
  }
  if (!same(transaction.to, expected.to) ||
      transaction.data.toLowerCase() !== expected.data.toLowerCase()) {
    return reject("TRANSACTION_MISMATCH");
  }

  const nowSeconds = BigInt(Math.floor(request.now / 1_000));
  let payloadHash: Hex;
  if (intent.kind === "monad_v4_approval") {
    if (!("stage" in expected) ||
        (expected.token !== pool.currency0 && expected.token !== pool.currency1) ||
        (expected.stage === "erc20" && !same(expected.to, expected.token)) ||
        (expected.stage === "permit2" &&
          (!same(expected.to, UNISWAP_V4_MONAD.permit2) ||
            expected.expiration <= nowSeconds ||
            expected.expiration > nowSeconds + 3n * 24n * 60n * 60n))) {
      return reject("APPROVAL_CONSTRAINT_INVALID");
    }
    payloadHash = monadV4ApprovalPayloadHash(expected);
  } else if (intent.kind === "monad_v4_mint") {
    if (!("amount0Max" in expected) ||
        !same(expected.to, UNISWAP_V4_MONAD.positionManager) ||
        !same(expected.recipient, wallet.address) ||
        expected.amount0Max <= 0n || expected.amount1Max <= 0n ||
        expected.deadline <= nowSeconds || expected.deadline > nowSeconds + 1_800n) {
      return reject("MINT_CONSTRAINT_INVALID");
    }
    payloadHash = monadV4MintPayloadHash(expected);
  } else {
    if (!("kind" in expected) ||
        `monad_v4_position_${expected.kind}` !== intent.kind ||
        !same(expected.to, UNISWAP_V4_MONAD.positionManager) ||
        !same(expected.recipient, wallet.address) || expected.tokenId <= 0n ||
        expected.liquidity <= 0n ||
        expected.deadline <= nowSeconds || expected.deadline > nowSeconds + 1_800n) {
      return reject("POSITION_CONSTRAINT_INVALID");
    }
    payloadHash = monadV4PositionActionPayloadHash(expected);
  }
  return payloadHash === intent.payloadHash ? allowed : reject("PAYLOAD_HASH_MISMATCH");
}
