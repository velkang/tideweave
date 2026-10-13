import { getAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID, UNISWAP_V3_MONAD } from "./monad";
import type { ChainReadClient } from "./reads";

export type PoolVenue = "uniswap-v3" | "uniswap-v4" | "nadfun-v2";
export type PairToken = { address: Address; symbol: string; decimals: number };
export type PairPool = {
  chainId: typeof MONAD_CHAIN_ID;
  venue: PoolVenue;
  /** Pool address for v3 and nad.fun V2; pool ID for v4. */
  id: Address | Hex;
  token0: PairToken;
  token1: PairToken;
};

export type MonadV3Pool = PairPool & {
  venue: "uniswap-v3";
  id: Address;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
};

export type MonadV3PoolClient = Pick<ChainReadClient, "readContract"> & {
  getCode(parameters: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
};

const poolAbi = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

function address(value: unknown): Address {
  if (typeof value !== "string") throw new Error("INVALID_POOL_ADDRESS");
  return getAddress(value);
}

export async function readMonadPairToken(client: MonadV3PoolClient, tokenAddress: Address, blockNumber?: bigint): Promise<PairToken> {
  const [code, decimals, symbol] = await Promise.all([
    client.getCode({ address: tokenAddress, blockNumber }),
    client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "decimals", blockNumber }),
    client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "symbol", blockNumber }).catch(() => "TOKEN"),
  ]);
  if (!code || code === "0x" || typeof decimals !== "number" ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("UNSUPPORTED_POOL_TOKEN");
  return {
    address: tokenAddress,
    decimals,
    symbol: typeof symbol === "string" && symbol.length > 0 ? symbol.slice(0, 32) : "TOKEN",
  };
}

/** Read an existing, initialized Monad v3 pool and verify its factory identity. */
export async function readMonadV3Pool(input: {
  client: MonadV3PoolClient;
  poolAddress: Address;
  blockNumber?: bigint;
  /** Directory indexing may retain a canonical pool before it is initialized or funded. */
  requireActive?: boolean;
}): Promise<MonadV3Pool> {
  const { client, blockNumber } = input;
  const id = getAddress(input.poolAddress);
  const code = await client.getCode({ address: id, blockNumber });
  if (!code || code === "0x") throw new Error("POOL_NOT_CONTRACT");
  const read = (functionName: "factory" | "token0" | "token1" | "fee" | "tickSpacing" | "slot0" | "liquidity") =>
    client.readContract({ address: id, abi: poolAbi, functionName, blockNumber });
  const [factory, rawToken0, rawToken1, fee, tickSpacing, slot0, liquidity] = await Promise.all([
    read("factory"), read("token0"), read("token1"), read("fee"), read("tickSpacing"), read("slot0"), read("liquidity"),
  ]);
  const token0 = address(rawToken0);
  const token1 = address(rawToken1);
  if (address(factory) !== UNISWAP_V3_MONAD.factory || token0 === zeroAddress || token1 === zeroAddress ||
      token0.toLowerCase() >= token1.toLowerCase()) throw new Error("POOL_NOT_CANONICAL");
  if (typeof fee !== "number" || !Number.isInteger(fee) || fee <= 0 || fee >= 1_000_000 ||
      typeof tickSpacing !== "number" || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("POOL_PARAMETERS_INVALID");
  }
  const canonical = await client.readContract({ address: UNISWAP_V3_MONAD.factory, abi: factoryAbi,
    functionName: "getPool", args: [token0, token1, fee], blockNumber });
  if (address(canonical) !== id) throw new Error("POOL_NOT_CANONICAL");
  if (!Array.isArray(slot0) || typeof slot0[0] !== "bigint" || typeof slot0[1] !== "number" ||
      slot0[0] < 0n || slot0[0] >= (1n << 160n) || typeof liquidity !== "bigint" || liquidity < 0n ||
      (input.requireActive !== false && (slot0[0] === 0n || liquidity === 0n))) {
    throw new Error("POOL_NOT_ACTIVE");
  }
  const [metadata0, metadata1] = await Promise.all([
    readMonadPairToken(client, token0, blockNumber), readMonadPairToken(client, token1, blockNumber),
  ]);
  return { chainId: MONAD_CHAIN_ID, venue: "uniswap-v3", id, token0: metadata0, token1: metadata1,
    fee, tickSpacing, sqrtPriceX96: slot0[0], tick: slot0[1], liquidity };
}
