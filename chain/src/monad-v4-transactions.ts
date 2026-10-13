import { Ether, Percent, Token } from "@uniswap/sdk-core";
import { Pool, Position, V4PositionManager } from "@uniswap/v4-sdk";
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, isAddressEqual, keccak256,
  parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID, UNISWAP_V4_MONAD } from "./monad";
import { monadV4PoolId, readMonadV4Pool,
  type MonadV4Pool, type MonadV4PoolKey } from "./monad-v4-pool";
import type { MonadV3PoolClient } from "./pair-pool";
export const v4PositionManagerReadAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);

// The position NFTs a transaction minted to the owner, read from its receipt logs.
function v4MintedTokenIds(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  owner: Address,
  positionManager: Address,
): bigint[] {
  const ids: bigint[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, positionManager)) continue;
    try {
      const event = decodeEventLog({ abi: v4PositionManagerReadAbi, eventName: "Transfer",
        data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
      if (event.args.from === zeroAddress && isAddressEqual(event.args.to, owner)) ids.push(event.args.tokenId);
    } catch { /* PositionManager emits other events in the same receipt. */ }
  }
  return ids;
}



const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export async function readMonadV4TokenAssets(input: {
  client: MonadV3PoolClient;
  owner: Address;
  token: Address;
  blockNumber?: bigint;
}) {
  const owner = getAddress(input.owner);
  const token = getAddress(input.token);
  const [balance, erc20Allowance, permit2Allowance] = await Promise.all([
    input.client.readContract({ address: token, abi: erc20Abi,
      functionName: "balanceOf", args: [owner], blockNumber: input.blockNumber }),
    input.client.readContract({ address: token, abi: erc20Abi,
      functionName: "allowance", args: [owner, UNISWAP_V4_MONAD.permit2],
      blockNumber: input.blockNumber }),
    input.client.readContract({ address: UNISWAP_V4_MONAD.permit2, abi: permit2Abi,
      functionName: "allowance", args: [owner, token, UNISWAP_V4_MONAD.positionManager],
      blockNumber: input.blockNumber }),
  ]);
  if (typeof balance !== "bigint" || typeof erc20Allowance !== "bigint" ||
      !Array.isArray(permit2Allowance) || typeof permit2Allowance[0] !== "bigint" ||
      typeof permit2Allowance[1] !== "number") throw new Error("V4_TOKEN_ASSETS_UNAVAILABLE");
  return { balance, erc20Allowance, permit2Allowance: permit2Allowance[0],
    permit2Expiration: BigInt(permit2Allowance[1]) };
}

export type MonadV4Approval = {
  chainId: typeof MONAD_CHAIN_ID;
  stage: "erc20" | "permit2";
  poolId: Hex;
  token: Address;
  amount: bigint;
  expiration: bigint;
  to: Address;
  data: Hex;
  value: 0n;
};

export function buildMonadV4Approval(input: {
  pool: MonadV4Pool;
  token: Address;
  stage: MonadV4Approval["stage"];
  amount: bigint;
  expiration?: bigint;
}): MonadV4Approval {
  if (monadV4PoolId(input.pool) !== input.pool.id ||
      input.amount <= 0n || input.amount > (1n << 160n) - 1n) {
    throw new Error("INVALID_V4_APPROVAL");
  }
  const token = getAddress(input.token);
  if (token !== input.pool.currency0 && token !== input.pool.currency1) {
    throw new Error("TOKEN_NOT_IN_V4_POOL");
  }
  if (token === zeroAddress) throw new Error("NATIVE_NEEDS_NO_APPROVAL");
  const expiration = input.stage === "permit2" ? input.expiration ?? 0n : 0n;
  if (input.stage === "permit2" && (expiration <= 0n || expiration > (1n << 48n) - 1n)) {
    throw new Error("INVALID_PERMIT2_EXPIRATION");
  }
  const to = input.stage === "erc20" ? token : UNISWAP_V4_MONAD.permit2;
  const data = input.stage === "erc20"
    ? encodeFunctionData({ abi: erc20Abi, functionName: "approve",
      args: [UNISWAP_V4_MONAD.permit2, input.amount] })
    : encodeFunctionData({ abi: permit2Abi, functionName: "approve",
      args: [token, UNISWAP_V4_MONAD.positionManager, input.amount, Number(expiration)] });
  return { chainId: MONAD_CHAIN_ID, stage: input.stage, poolId: input.pool.id,
    token, amount: input.amount, expiration, to, data, value: 0n };
}

export function monadV4ApprovalPayloadHash(approval: MonadV4Approval): Hex {
  return keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "bytes32" }, { type: "address" },
    { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" },
  ], [BigInt(approval.chainId), approval.poolId, approval.token,
    approval.stage === "erc20" ? 0 : 1, approval.amount, approval.expiration,
    approval.data]));
}

export const monadV4MintedTokenIds = (
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[], owner: Address,
) => v4MintedTokenIds(logs, owner, UNISWAP_V4_MONAD.positionManager);

export async function readMonadV4Position(input: {
  client: MonadV3PoolClient;
  tokenId: bigint;
  owner: Address;
  blockNumber?: bigint;
}) {
  if (input.tokenId <= 0n) throw new Error("POSITION_TOKEN_ID_INVALID");
  const [owner, info, liquidity] = await Promise.all([
    input.client.readContract({ address: UNISWAP_V4_MONAD.positionManager,
      abi: v4PositionManagerReadAbi, functionName: "ownerOf",
      args: [input.tokenId], blockNumber: input.blockNumber }),
    input.client.readContract({ address: UNISWAP_V4_MONAD.positionManager,
      abi: v4PositionManagerReadAbi, functionName: "getPoolAndPositionInfo",
      args: [input.tokenId], blockNumber: input.blockNumber }),
    input.client.readContract({ address: UNISWAP_V4_MONAD.positionManager,
      abi: v4PositionManagerReadAbi, functionName: "getPositionLiquidity",
      args: [input.tokenId], blockNumber: input.blockNumber }),
  ]);
  if (typeof owner !== "string" || !isAddressEqual(owner as Address, input.owner) ||
      !Array.isArray(info) || typeof info[1] !== "bigint" ||
      typeof liquidity !== "bigint") throw new Error("POSITION_NOT_OWNED");
  const key = info[0] as MonadV4PoolKey;
  const signedTick = (value: bigint) => value >= 1n << 23n
    ? Number(value - (1n << 24n)) : Number(value);
  const tickLower = signedTick((info[1] >> 8n) & 0xffffffn);
  const tickUpper = signedTick((info[1] >> 32n) & 0xffffffn);
  const pool = await readMonadV4Pool({ client: input.client, key,
    blockNumber: input.blockNumber, requireActive: false });
  if (tickLower >= tickUpper || tickLower % pool.tickSpacing !== 0 ||
      tickUpper % pool.tickSpacing !== 0) throw new Error("POSITION_RANGE_INVALID");
  return { tokenId: input.tokenId, pool, tickLower, tickUpper, liquidity };
}

// Ether.onChain returns one cached instance per chain; the SDK requires the pool's native
// currency and the mint's useNative option to be that same object.
const nativeMon = () => Ether.onChain(MONAD_CHAIN_ID);
const isNativePool = (pool: MonadV4Pool) => pool.currency0 === zeroAddress;

function sdkPool(pool: MonadV4Pool): Pool {
  return new Pool(
    isNativePool(pool) ? nativeMon()
      : new Token(MONAD_CHAIN_ID, pool.currency0, pool.token0.decimals, pool.token0.symbol),
    new Token(MONAD_CHAIN_ID, pool.currency1, pool.token1.decimals, pool.token1.symbol),
    pool.fee, pool.tickSpacing, pool.hooks,
    pool.sqrtPriceX96.toString(), pool.liquidity.toString(), pool.tick,
  );
}

export type MonadV4Mint = {
  chainId: typeof MONAD_CHAIN_ID;
  poolId: Hex;
  to: Address;
  data: Hex;
  /** amount0Max of native MON for a native pool (any unused part is swept back); else 0. */
  value: bigint;
  recipient: Address;
  tickLower: number;
  tickUpper: number;
  amount0Max: bigint;
  amount1Max: bigint;
  amount0Expected: bigint;
  amount1Expected: bigint;
  deadline: bigint;
};

export function buildMonadV4Mint(input: {
  pool: MonadV4Pool;
  recipient: Address;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  slippageBps: number;
  deadline: bigint;
}): MonadV4Mint {
  const { pool } = input;
  if (monadV4PoolId(pool) !== pool.id || pool.sqrtPriceX96 <= 0n || pool.liquidity <= 0n ||
      input.amount0Desired <= 0n || input.amount1Desired <= 0n ||
      !Number.isInteger(input.tickLower) || !Number.isInteger(input.tickUpper) ||
      input.tickLower < -887_272 || input.tickUpper > 887_272 ||
      input.tickLower >= input.tickUpper ||
      input.tickLower % pool.tickSpacing !== 0 || input.tickUpper % pool.tickSpacing !== 0 ||
      !Number.isInteger(input.slippageBps) || input.slippageBps < 0 ||
      input.slippageBps > 500 || input.deadline <= 0n) {
    throw new Error("INVALID_V4_MINT_LIMITS");
  }
  const currentPool = sdkPool(pool);
  let position = Position.fromAmounts({ pool: currentPool,
    tickLower: input.tickLower, tickUpper: input.tickUpper,
    amount0: input.amount0Desired.toString(), amount1: input.amount1Desired.toString(),
    useFullPrecision: true });
  const slippageTolerance = new Percent(input.slippageBps, 10_000);
  let amount0Max = 0n;
  let amount1Max = 0n;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const amounts = position.mintAmountsWithSlippage(slippageTolerance);
    amount0Max = BigInt(amounts.amount0.toString());
    amount1Max = BigInt(amounts.amount1.toString());
    if (amount0Max <= 0n || amount1Max <= 0n) {
      throw new Error("V4_MINT_REQUIRES_BOTH_TOKENS");
    }
    if (amount0Max <= input.amount0Desired && amount1Max <= input.amount1Desired) break;
    const liquidity = BigInt(position.liquidity.toString());
    const scaled0 = liquidity * input.amount0Desired / amount0Max;
    const scaled1 = liquidity * input.amount1Desired / amount1Max;
    const scaled = [scaled0, scaled1, liquidity - 1n]
      .reduce((smallest, value) => value < smallest ? value : smallest);
    if (scaled <= 0n) throw new Error("V4_MINT_REQUIRES_BOTH_TOKENS");
    position = new Position({ pool: currentPool, liquidity: scaled.toString(),
      tickLower: input.tickLower, tickUpper: input.tickUpper });
  }
  if (amount0Max > input.amount0Desired || amount1Max > input.amount1Desired) {
    throw new Error("V4_MINT_EXCEEDS_BUDGET");
  }
  const amount0Expected = BigInt(position.mintAmounts.amount0.toString());
  const amount1Expected = BigInt(position.mintAmounts.amount1.toString());
  if (amount0Expected <= 0n || amount1Expected <= 0n) {
    throw new Error("V4_MINT_REQUIRES_BOTH_TOKENS");
  }
  const recipient = getAddress(input.recipient);
  const encoded = V4PositionManager.addCallParameters(position, {
    recipient, slippageTolerance, deadline: input.deadline.toString(), hookData: "0x",
    ...(isNativePool(pool) ? { useNative: nativeMon() } : {}),
  });
  const value = BigInt(encoded.value);
  if (value !== (isNativePool(pool) ? amount0Max : 0n)) throw new Error("V4_MINT_VALUE_MISMATCH");
  return { chainId: MONAD_CHAIN_ID, poolId: pool.id,
    to: UNISWAP_V4_MONAD.positionManager, data: encoded.calldata as Hex,
    value, recipient, tickLower: input.tickLower, tickUpper: input.tickUpper,
    amount0Max, amount1Max, amount0Expected, amount1Expected,
    deadline: input.deadline };
}

export function monadV4MintPayloadHash(mint: MonadV4Mint): Hex {
  return keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "address" }, { type: "bytes32" },
    { type: "address" }, { type: "uint256" }, { type: "bytes" },
  ], [BigInt(mint.chainId), mint.to, mint.poolId, mint.recipient, mint.value, mint.data]));
}

export type MonadV4PositionAction = {
  chainId: typeof MONAD_CHAIN_ID;
  /** Collect fees, remove a share of the liquidity (fees included), or remove all of it and burn the NFT. */
  kind: "collect" | "decrease" | "withdraw";
  /** The share of liquidity removed, in basis points: 0 for a collect, 10,000 for a withdrawal. */
  removeBps: number;
  poolId: Hex;
  tokenId: bigint;
  recipient: Address;
  liquidity: bigint;
  deadline: bigint;
  to: Address;
  data: Hex;
  value: 0n;
};

export function buildMonadV4PositionAction(input: {
  kind: MonadV4PositionAction["kind"];
  /** For a decrease: the share of liquidity to remove, 1 to 9,999 basis points. */
  removeBps?: number;
  position: Awaited<ReturnType<typeof readMonadV4Position>>;
  recipient: Address;
  slippageBps: number;
  deadline: bigint;
}): MonadV4PositionAction {
  const { pool, tokenId, liquidity, tickLower, tickUpper } = input.position;
  if (monadV4PoolId(pool) !== pool.id || pool.sqrtPriceX96 <= 0n ||
      tokenId <= 0n || liquidity <= 0n ||
      tickLower >= tickUpper || tickLower % pool.tickSpacing !== 0 ||
      tickUpper % pool.tickSpacing !== 0 ||
      !Number.isInteger(input.slippageBps) || input.slippageBps < 0 ||
      input.slippageBps > 500 || input.deadline <= 0n ||
      (input.kind === "decrease" && (!Number.isInteger(input.removeBps) || input.removeBps! < 1 ||
        input.removeBps! > 9_999))) {
    throw new Error("INVALID_V4_POSITION_ACTION");
  }
  const removeBps = input.kind === "collect" ? 0 : input.kind === "withdraw" ? 10_000 : input.removeBps!;
  const position = new Position({ pool: sdkPool(pool), liquidity: liquidity.toString(),
    tickLower, tickUpper });
  const recipient = getAddress(input.recipient);
  const common = { tokenId: tokenId.toString(), deadline: input.deadline.toString(),
    slippageTolerance: new Percent(input.slippageBps, 10_000), hookData: "0x" };
  const encoded = input.kind === "collect"
    ? V4PositionManager.collectCallParameters(position, { ...common, recipient })
    : V4PositionManager.removeCallParameters(position, { ...common,
      liquidityPercentage: new Percent(removeBps, 10_000), burnToken: input.kind === "withdraw" });
  if (BigInt(encoded.value) !== 0n) throw new Error("NATIVE_VALUE_NOT_ALLOWED");
  return { chainId: MONAD_CHAIN_ID, kind: input.kind, removeBps, poolId: pool.id,
    tokenId, recipient, liquidity, deadline: input.deadline,
    to: UNISWAP_V4_MONAD.positionManager, data: encoded.calldata as Hex, value: 0n };
}

export function monadV4PositionActionPayloadHash(action: MonadV4PositionAction): Hex {
  return keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "uint8" }, { type: "bytes32" },
    { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" },
  ], [BigInt(action.chainId), action.kind === "collect" ? 0 : action.kind === "withdraw" ? 1 : 2,
    action.poolId, action.tokenId, action.recipient, action.liquidity, action.data]));
}
