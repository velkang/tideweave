import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { MONAD_CHAIN_ID, UNISWAP_V3_MONAD } from "./monad";
import { readMonadV3Pool, type MonadV3Pool, type MonadV3PoolClient } from "./pair-pool";
import type { ApprovalSimulationClient } from "./approvals";

export const positionManagerAbi = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);

export function monadV3MintedTokenIds(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  owner: Address,
): bigint[] {
  const ids: bigint[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== UNISWAP_V3_MONAD.nonfungiblePositionManager.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: positionManagerAbi, eventName: "Transfer",
        data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
      if (event.args.from === zeroAddress &&
          event.args.to.toLowerCase() === owner.toLowerCase()) ids.push(event.args.tokenId);
    } catch { /* Other manager events in the same receipt. */ }
  }
  return ids;
}
const poolFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const MAX_SLIPPAGE_BPS = 500;

type MintPool = { address: Address; token0: MonadV3Pool["token0"]; token1: MonadV3Pool["token1"]; fee: number; tickSpacing: number };

export type Mint<ChainId extends number = typeof MONAD_CHAIN_ID> = {
  chainId: ChainId;
  to: Address;
  data: Hex;
  value: 0n;
  recipient: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  slippageBps: number;
  deadline: bigint;
};

type MintInput = {
  pool: MintPool;
  recipient: Address;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  slippageBps: number;
  deadline: bigint;
  amount0Min?: bigint;
  amount1Min?: bigint;
};

function buildMintFor<ChainId extends number>(input: MintInput,
  deployment: { chainId: ChainId; manager: Address }): Mint<ChainId> {
  if (!Number.isInteger(input.pool.tickSpacing) || input.pool.tickSpacing <= 0) {
    throw new Error("Invalid pool tick spacing");
  }
  if (
    !Number.isInteger(input.tickLower) ||
    !Number.isInteger(input.tickUpper) ||
    input.tickLower < MIN_TICK ||
    input.tickUpper > MAX_TICK ||
    input.tickLower >= input.tickUpper ||
    input.tickLower % input.pool.tickSpacing !== 0 ||
    input.tickUpper % input.pool.tickSpacing !== 0
  ) throw new Error("Invalid position tick range");
  if (input.amount0Desired <= 0n || input.amount1Desired <= 0n) {
    throw new Error("Both position amounts must be positive");
  }
  if (
    !Number.isInteger(input.slippageBps) ||
    input.slippageBps < 0 ||
    input.slippageBps > MAX_SLIPPAGE_BPS
  ) throw new Error("Position slippage exceeds policy");
  if (input.deadline <= 0n) throw new Error("Invalid position deadline");
  const amount0Min = input.amount0Min ??
    (input.amount0Desired * BigInt(10_000 - input.slippageBps)) / 10_000n;
  const amount1Min = input.amount1Min ??
    (input.amount1Desired * BigInt(10_000 - input.slippageBps)) / 10_000n;
  if (
    amount0Min < 0n || amount1Min < 0n ||
    amount0Min > input.amount0Desired || amount1Min > input.amount1Desired
  ) throw new Error("Position min amounts are invalid");
  const recipient = getAddress(input.recipient);
  const parameters = {
    token0: input.pool.token0.address,
    token1: input.pool.token1.address,
    fee: input.pool.fee,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0Desired: input.amount0Desired,
    amount1Desired: input.amount1Desired,
    amount0Min,
    amount1Min,
    recipient,
    deadline: input.deadline,
  };
  return {
    chainId: deployment.chainId,
    to: deployment.manager,
    data: encodeFunctionData({ abi: positionManagerAbi, functionName: "mint", args: [parameters] }),
    value: 0n,
    recipient,
    token0: input.pool.token0.address,
    token1: input.pool.token1.address,
    fee: input.pool.fee,
    tickSpacing: input.pool.tickSpacing,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0Desired: input.amount0Desired,
    amount1Desired: input.amount1Desired,
    amount0Min,
    amount1Min,
    slippageBps: input.slippageBps,
    deadline: input.deadline,
  };
}

export function buildMonadV3Mint(input: Omit<MintInput, "pool"> & { pool: MonadV3Pool }):
  Mint<typeof MONAD_CHAIN_ID> {
  if (input.pool.chainId !== MONAD_CHAIN_ID || input.pool.venue !== "uniswap-v3" ||
      input.pool.sqrtPriceX96 <= 0n || input.pool.liquidity <= 0n) {
    throw new Error("POOL_NOT_ACTIVE");
  }
  return buildMintFor({ ...input, pool: { address: input.pool.id,
    token0: input.pool.token0, token1: input.pool.token1,
    fee: input.pool.fee, tickSpacing: input.pool.tickSpacing } },
  { chainId: MONAD_CHAIN_ID, manager: UNISWAP_V3_MONAD.nonfungiblePositionManager });
}

export function mintPayloadHash(mint: Pick<Mint<number>, "chainId" | "to" | "recipient" | "data">): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes" },
      ],
      [BigInt(mint.chainId), mint.to, mint.recipient, mint.data],
    ),
  );
}

export async function simulateMint(input: {
  client: ApprovalSimulationClient;
  owner: Address;
  mint: Mint<number>;
  blockNumber: bigint;
}) {
  const simulation = await input.client.simulateContract({
    account: input.owner,
    address: input.mint.to,
    abi: positionManagerAbi,
    functionName: "mint",
    args: [{
      token0: input.mint.token0,
      token1: input.mint.token1,
      fee: input.mint.fee,
      tickLower: input.mint.tickLower,
      tickUpper: input.mint.tickUpper,
      amount0Desired: input.mint.amount0Desired,
      amount1Desired: input.mint.amount1Desired,
      amount0Min: input.mint.amount0Min,
      amount1Min: input.mint.amount1Min,
      recipient: input.mint.recipient,
      deadline: input.mint.deadline,
    }],
    blockNumber: input.blockNumber,
  });
  if (!Array.isArray(simulation.result) || simulation.result.length !== 4) {
    throw new Error("Invalid mint simulation result");
  }
  const [tokenId, liquidity, amount0, amount1] = simulation.result;
  if ([tokenId, liquidity, amount0, amount1].some((value) => typeof value !== "bigint")) {
    throw new Error("Invalid mint simulation result");
  }
  const gasEstimate = await input.client.estimateGas({
    account: input.owner,
    to: input.mint.to,
    data: input.mint.data,
    value: 0n,
    blockNumber: input.blockNumber,
  });
  return {
    blockNumber: input.blockNumber.toString(),
    gasEstimate: gasEstimate.toString(),
    tokenId: (tokenId as bigint).toString(),
    liquidity: (liquidity as bigint).toString(),
    amount0: (amount0 as bigint).toString(),
    amount1: (amount1 as bigint).toString(),
  };
}

/** Read an owned Monad v3 position and verify its pool through the canonical factory. */
export async function readMonadV3Position(input: {
  client: MonadV3PoolClient;
  owner: Address;
  tokenId: bigint;
  blockNumber?: bigint;
}) {
  if (input.tokenId <= 0n) throw new Error("INVALID_POSITION_TOKEN_ID");
  const { client, blockNumber } = input;
  const manager = UNISWAP_V3_MONAD.nonfungiblePositionManager;
  const [owner, position] = await Promise.all([
    client.readContract({ address: manager, abi: positionManagerAbi,
      functionName: "ownerOf", args: [input.tokenId], blockNumber }),
    client.readContract({ address: manager, abi: positionManagerAbi,
      functionName: "positions", args: [input.tokenId], blockNumber }),
  ]);
  if (typeof owner !== "string" || getAddress(owner) !== getAddress(input.owner)) {
    throw new Error("POSITION_NOT_OWNED");
  }
  if (!Array.isArray(position) || typeof position[2] !== "string" ||
      typeof position[3] !== "string" || typeof position[4] !== "number" ||
      typeof position[5] !== "number" || typeof position[6] !== "number" ||
      typeof position[7] !== "bigint" || typeof position[10] !== "bigint" ||
      typeof position[11] !== "bigint") throw new Error("POSITION_INVALID");
  const token0 = getAddress(position[2]);
  const token1 = getAddress(position[3]);
  const fee = position[4];
  const poolAddress = await client.readContract({ address: UNISWAP_V3_MONAD.factory,
    abi: poolFactoryAbi,
    functionName: "getPool", args: [token0, token1, fee], blockNumber });
  if (typeof poolAddress !== "string" || getAddress(poolAddress) === zeroAddress) {
    throw new Error("POSITION_POOL_NOT_CANONICAL");
  }
  const pool = await readMonadV3Pool({ client, poolAddress: getAddress(poolAddress), blockNumber,
    requireActive: false });
  if (pool.token0.address !== token0 || pool.token1.address !== token1 || pool.fee !== fee) {
    throw new Error("POSITION_POOL_MISMATCH");
  }
  return { tokenId: input.tokenId, pool, tickLower: position[5], tickUpper: position[6],
    liquidity: position[7], tokensOwed0: position[10], tokensOwed1: position[11] };
}
