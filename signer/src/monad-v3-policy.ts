import { MONAD_CHAIN_ID, UNISWAP_V3_MONAD, approvalPayloadHash, mintPayloadHash,
  positionActionPayloadHash, managerAbi, positionManagerAbi, type MonadV3Pool,
  type PositionAction } from "@tideweave/chain";
import { decodeFunctionData, maxUint128, parseAbi, type Address, type Hex } from "viem";
import type { WalletState } from "./policy";

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const kinds = ["monad_v3_approval", "monad_v3_mint", "monad_v3_position_increase",
  "monad_v3_position_decrease", "monad_v3_position_collect", "monad_v3_position_withdraw"] as const;
export type MonadV3IntentKind = typeof kinds[number];
export const isMonadV3IntentKind = (kind: string): kind is MonadV3IntentKind =>
  (kinds as readonly string[]).includes(kind);

export type MonadV3PolicyRequest = {
  now: number;
  emergencyStop: boolean;
  wallet: { address: Address; state: WalletState };
  intent: { kind: MonadV3IntentKind; status: string; expiresAt: number; payloadHash: Hex };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  pool: MonadV3Pool;
  mintExpected?: { amount0: bigint; amount1: bigint };
  position?: { tokenId: bigint; owner: Address; liquidity: bigint;
    expected0?: bigint; expected1?: bigint };
  simulation: { success: boolean; blockNumber: bigint; latestBlockNumber: bigint };
};

export type MonadV3PolicyDecision = { allowed: true; reason: "POLICY_ALLOWED" } |
  { allowed: false; reason: string };
const allowed: MonadV3PolicyDecision = { allowed: true, reason: "POLICY_ALLOWED" };
const reject = (reason: string): MonadV3PolicyDecision => ({ allowed: false, reason });
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
const minimum = (amount: bigint) => amount * 9_500n / 10_000n;
const deadlineValid = (deadline: bigint, now: number) => {
  const seconds = BigInt(Math.floor(now / 1_000));
  return deadline > seconds && deadline <= seconds + 1_800n;
};
const positiveRange = (lower: number, upper: number, spacing: number) =>
  Number.isInteger(spacing) && spacing > 0 && lower >= -887_272 && upper <= 887_272 &&
  lower < upper && lower % spacing === 0 && upper % spacing === 0;

export function validateMonadV3Intent(request: MonadV3PolicyRequest): MonadV3PolicyDecision {
  const { intent, transaction, pool, wallet, simulation } = request;
  const exit = intent.kind === "monad_v3_position_decrease" ||
    intent.kind === "monad_v3_position_collect" || intent.kind === "monad_v3_position_withdraw";
  if (request.emergencyStop && !exit) return reject("EMERGENCY_STOP_ACTIVE");
  if (intent.status !== "pending") return reject("INTENT_NOT_PENDING");
  if (intent.expiresAt <= request.now) return reject("INTENT_EXPIRED");
  if (transaction.chainId !== MONAD_CHAIN_ID || pool.chainId !== MONAD_CHAIN_ID) {
    return reject("CHAIN_NOT_ALLOWED");
  }
  if (transaction.value !== 0n) return reject("NATIVE_VALUE_NOT_ALLOWED");
  if (wallet.state !== "active" && !(exit && wallet.state === "paused")) {
    return reject("WALLET_NOT_SIGNABLE");
  }
  if (!simulation.success) return reject("SIMULATION_FAILED");
  if (simulation.latestBlockNumber < simulation.blockNumber ||
      simulation.latestBlockNumber - simulation.blockNumber > 2n) {
    return reject("SIMULATION_STALE");
  }
  if (pool.venue !== "uniswap-v3" ||
      !Number.isInteger(pool.tickSpacing) || pool.tickSpacing <= 0 ||
      pool.token0.address.toLowerCase() >= pool.token1.address.toLowerCase()) {
    return reject("POOL_NOT_CANONICAL");
  }
  if (!exit && (pool.sqrtPriceX96 <= 0n || pool.liquidity <= 0n)) return reject("POOL_NOT_ACTIVE");

  if (intent.kind === "monad_v3_approval") {
    if (!same(transaction.to, pool.token0.address) && !same(transaction.to, pool.token1.address)) {
      return reject("TOKEN_NOT_IN_POOL");
    }
    let decoded;
    try { decoded = decodeFunctionData({ abi: approveAbi, data: transaction.data }); }
    catch { return reject("CALLDATA_INVALID"); }
    if (decoded.functionName !== "approve" ||
        !same(decoded.args[0], UNISWAP_V3_MONAD.nonfungiblePositionManager) ||
        decoded.args[1] <= 0n) return reject("APPROVAL_INVALID");
    return approvalPayloadHash({ chainId: MONAD_CHAIN_ID, tokenSymbol: "TOKEN",
      tokenAddress: transaction.to, spender: decoded.args[0], amount: decoded.args[1],
      to: transaction.to, data: transaction.data, value: 0n }) === intent.payloadHash
      ? allowed : reject("PAYLOAD_HASH_MISMATCH");
  }

  if (!same(transaction.to, UNISWAP_V3_MONAD.nonfungiblePositionManager)) {
    return reject("TARGET_NOT_ALLOWED");
  }
  if (intent.kind === "monad_v3_mint") {
    let decoded;
    try { decoded = decodeFunctionData({ abi: positionManagerAbi, data: transaction.data }); }
    catch { return reject("CALLDATA_INVALID"); }
    if (decoded.functionName !== "mint") return reject("SELECTOR_NOT_ALLOWED");
    const p = decoded.args[0];
    if (!same(p.token0, pool.token0.address) || !same(p.token1, pool.token1.address) ||
        p.fee !== pool.fee || !same(p.recipient, wallet.address)) return reject("POOL_OR_RECIPIENT_MISMATCH");
    if (!positiveRange(p.tickLower, p.tickUpper, pool.tickSpacing)) return reject("TICK_RANGE_INVALID");
    const expected = request.mintExpected;
    if (!expected || expected.amount0 <= 0n || expected.amount1 <= 0n ||
        expected.amount0 > p.amount0Desired || expected.amount1 > p.amount1Desired ||
        p.amount0Min < minimum(expected.amount0) ||
        p.amount1Min < minimum(expected.amount1)) {
      return reject("AMOUNT_OR_SLIPPAGE_INVALID");
    }
    if (!deadlineValid(p.deadline, request.now)) return reject("DEADLINE_INVALID");
    return mintPayloadHash({ chainId: MONAD_CHAIN_ID, to: transaction.to,
      recipient: p.recipient, data: transaction.data }) === intent.payloadHash
      ? allowed : reject("PAYLOAD_HASH_MISMATCH");
  }

  let decoded;
  try { decoded = decodeFunctionData({ abi: managerAbi, data: transaction.data }); }
  catch { return reject("CALLDATA_INVALID"); }
  const position = request.position;
  if (!position || !same(position.owner, wallet.address)) return reject("POSITION_NOT_OWNED");
  const actionKind = intent.kind.replace("monad_v3_position_", "") as PositionAction["kind"];
  const expectedSelector = { increase: "increaseLiquidity", decrease: "decreaseLiquidity",
    collect: "collect", withdraw: "multicall" }[actionKind];
  if (decoded.functionName !== expectedSelector) return reject("SELECTOR_NOT_ALLOWED");
  let tokenId: bigint;
  if (decoded.functionName === "multicall") {
    if (decoded.args[0].length !== 3) return reject("WITHDRAWAL_SEQUENCE_INVALID");
    try {
      const [decrease, collect, burn] = decoded.args[0].map((data) =>
        decodeFunctionData({ abi: managerAbi, data }));
      if (decrease.functionName !== "decreaseLiquidity" || collect.functionName !== "collect" ||
          burn.functionName !== "burn") return reject("WITHDRAWAL_SEQUENCE_INVALID");
      tokenId = decrease.args[0].tokenId;
      if (tokenId !== position.tokenId || decrease.args[0].liquidity !== position.liquidity ||
          position.liquidity <= 0n || collect.args[0].tokenId !== tokenId || burn.args[0] !== tokenId ||
          !same(collect.args[0].recipient, wallet.address) ||
          collect.args[0].amount0Max !== maxUint128 || collect.args[0].amount1Max !== maxUint128 ||
          !deadlineValid(decrease.args[0].deadline, request.now) ||
          position.expected0 === undefined || position.expected1 === undefined ||
          decrease.args[0].amount0Min < minimum(position.expected0) ||
          decrease.args[0].amount1Min < minimum(position.expected1)) {
        return reject("WITHDRAWAL_CONSTRAINT_INVALID");
      }
    } catch { return reject("WITHDRAWAL_SEQUENCE_INVALID"); }
  } else {
    if (decoded.functionName === "collect") {
      const p = decoded.args[0];
      tokenId = p.tokenId;
      if (tokenId !== position.tokenId) return reject("POSITION_CONTEXT_MISMATCH");
      if (!same(p.recipient, wallet.address) || p.amount0Max !== maxUint128 ||
          p.amount1Max !== maxUint128) return reject("COLLECT_CONSTRAINT_INVALID");
    } else if (decoded.functionName === "increaseLiquidity") {
      const p = decoded.args[0];
      tokenId = p.tokenId;
      if (tokenId !== position.tokenId) return reject("POSITION_CONTEXT_MISMATCH");
      if (p.amount0Desired < 0n || p.amount1Desired < 0n ||
          p.amount0Desired + p.amount1Desired <= 0n ||
          p.amount0Min < minimum(p.amount0Desired) ||
          p.amount1Min < minimum(p.amount1Desired) ||
          !deadlineValid(p.deadline, request.now)) return reject("INCREASE_CONSTRAINT_INVALID");
    } else if (decoded.functionName === "decreaseLiquidity") {
      const p = decoded.args[0];
      tokenId = p.tokenId;
      if (tokenId !== position.tokenId) return reject("POSITION_CONTEXT_MISMATCH");
      if (p.liquidity <= 0n || p.liquidity > position.liquidity ||
          position.expected0 === undefined || position.expected1 === undefined ||
          p.amount0Min < minimum(position.expected0) ||
          p.amount1Min < minimum(position.expected1) ||
          !deadlineValid(p.deadline, request.now)) return reject("DECREASE_CONSTRAINT_INVALID");
    } else return reject("SELECTOR_NOT_ALLOWED");
  }
  return positionActionPayloadHash({ chainId: MONAD_CHAIN_ID, kind: actionKind,
    tokenId, to: transaction.to, data: transaction.data, value: 0n,
    recipient: wallet.address }) === intent.payloadHash
    ? allowed : reject("PAYLOAD_HASH_MISMATCH");
}
