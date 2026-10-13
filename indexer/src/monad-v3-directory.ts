import { MONAD_CHAIN_ID, UNISWAP_V3_MONAD, discoverV3Pools, readMonadV3Pool } from "@tideweave/chain";
import { decodeEventLog, getAddress, pad, parseAbi, toEventSelector, toFunctionSelector,
  type Address, type Hex } from "viem";
import { rawCall, word, type RawRpcClient, type RpcLog } from "./directory-scan";
import type { CreatedPool, DirectoryClient, DirectoryRow, ProtocolDirectory } from "./pool-discovery";

const poolCreatedEvent = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
])[0];
const POOL_CREATED = toEventSelector(poolCreatedEvent);
const SLOT0 = toFunctionSelector("slot0()");
const LIQUIDITY = toFunctionSelector("liquidity()");
const topic = (address: Address) => pad(address.toLowerCase() as Hex);

async function readState(client: RawRpcClient, pool: Address, block: bigint): Promise<DirectoryRow | null> {
  const [slot0, liquidity] = await Promise.all([
    rawCall(client, pool, SLOT0, block), rawCall(client, pool, LIQUIDITY, block),
  ]);
  const sqrtPrice = slot0 && word(slot0, 0);
  const tick = slot0 && word(slot0, 1);
  const liquidityValue = liquidity && word(liquidity, 0);
  if (sqrtPrice === null || tick === null || liquidityValue === null) return null;
  return { sqrt_price_x96: sqrtPrice.toString(), tick: Number(BigInt.asIntN(24, tick)),
    liquidity: liquidityValue.toString() };
}

/** The directory row for a canonical pool, or null when the pool or a token is unusable. */
async function buildRow(client: DirectoryClient, poolAddress: Address, block: bigint, updatedAt: number,
  createdBlock: number | null, expected?: { token0: Address; token1: Address; fee: number; tickSpacing: number }):
  Promise<DirectoryRow | null> {
  try {
    const pool = await readMonadV3Pool({ client, poolAddress, blockNumber: block, requireActive: false });
    if (expected && (pool.token0.address !== expected.token0 || pool.token1.address !== expected.token1 ||
        pool.fee !== expected.fee || pool.tickSpacing !== expected.tickSpacing)) return null;
    return { pool_address: pool.id, token0_address: pool.token0.address,
      token0_symbol: pool.token0.symbol, token0_decimals: pool.token0.decimals,
      token1_address: pool.token1.address, token1_symbol: pool.token1.symbol,
      token1_decimals: pool.token1.decimals, fee: pool.fee, tick_spacing: pool.tickSpacing,
      sqrt_price_x96: pool.sqrtPriceX96.toString(), tick: pool.tick,
      liquidity: pool.liquidity.toString(), block_number: Number(block), updated_at: updatedAt,
      created_block: createdBlock };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^(?:POOL_|UNSUPPORTED_POOL_TOKEN)/.test(message)) return null;
    throw error;
  }
}

function decode(log: RpcLog): CreatedPool | null {
  if (log.topics[0] !== POOL_CREATED ||
      log.address.toLowerCase() !== UNISWAP_V3_MONAD.factory.toLowerCase()) return null;
  try {
    const { args } = decodeEventLog({ abi: [poolCreatedEvent], data: log.data,
      topics: log.topics as [Hex, ...Hex[]] });
    const token0 = getAddress(args.token0);
    const token1 = getAddress(args.token1);
    const poolAddress = getAddress(args.pool);
    const createdBlock = Number(BigInt(log.blockNumber));
    return { key: poolAddress.toLowerCase(), block: BigInt(log.blockNumber), token: token0,
      tokens: [token0, token1],
      build: (client, block, updatedAt) => buildRow(client, poolAddress, block, updatedAt, createdBlock,
        { token0, token1, fee: args.fee, tickSpacing: args.tickSpacing }) };
  } catch {
    return null;
  }
}

/** A pasted token's pools, asked of the factory directly (their creation block is unknown). */
async function lookupToken(client: DirectoryClient, token: Address, block: bigint): Promise<CreatedPool[]> {
  const pools = await discoverV3Pools({ client, token, blockNumber: block });
  return pools.map((poolAddress) => ({ key: poolAddress.toLowerCase(), block: 0n, token, tokens: [token],
    build: (buildClient, buildBlock, updatedAt) => buildRow(buildClient, poolAddress, buildBlock, updatedAt, null) }));
}

export const monadV3Directory: ProtocolDirectory = {
  name: "monad-v3",
  protocol: "uniswap-v3",
  chainId: MONAD_CHAIN_ID,
  liveWindow: 100n,
  lookupWindow: 100n,
  lookupDepth: 1_000n,
  table: "monad_v3_pool_directory",
  keyColumn: "pool_address",
  columns: ["pool_address", "token0_address", "token0_symbol", "token0_decimals",
    "token1_address", "token1_symbol", "token1_decimals", "fee", "tick_spacing",
    "sqrt_price_x96", "tick", "liquidity", "block_number", "updated_at", "created_block"],
  stateColumns: ["sqrt_price_x96", "tick", "liquidity", "block_number", "updated_at"],
  usedBy: [{ table: "mint_intents", column: "pool_address" }],
  emitter: UNISWAP_V3_MONAD.factory,
  creationTopics: (token) => token
    ? [[POOL_CREATED, topic(token)], [POOL_CREATED, null, topic(token)]]
    : [[POOL_CREATED]],
  decode,
  lookupToken,
  readState: (client, row, block) => readState(client, getAddress(row.pool_address as string), block),
};
