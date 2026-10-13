import { getAddress, isAddress, type Address, type Hex } from "viem";
import { readMonadV3Pool, readMonadV4Pool, readNadPair, type MonadNadPair, type MonadV3Pool,
  type MonadV3PoolClient, type MonadV4Pool } from "@tideweave/chain";

// The three pool types share one Explore list and one pair shape; each venue keeps its own
// identity (v3 pool address, v4 pool id, nad.fun pair address) and venue-specific state.

export const VENUES = ["uniswap-v3", "uniswap-v4", "nadfun-v2"] as const;
export type Venue = typeof VENUES[number];
export type AnyPair = MonadV3Pool | MonadV4Pool | MonadNadPair;

export const isVenue = (value: string): value is Venue => (VENUES as readonly string[]).includes(value);
export const isPoolId = (value: string): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value);

/** True when `id` has the identity shape `venue` uses. */
export function validPairId(venue: Venue, id: string): boolean {
  return venue === "uniswap-v4" ? isPoolId(id) : isAddress(id);
}

/** Converts bigints to decimal strings, recursively, so a value can be sent as JSON. */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

type V4KeyRow = { currency0: Address; currency1: Address; fee: number; tick_spacing: number; hooks: Address };

/** The stored key of an indexed v4 pool: a pool id cannot be reversed into its key. */
export async function v4KeyRow(db: D1Database, poolId: Hex): Promise<V4KeyRow | null> {
  return db.prepare(
    "SELECT currency0, currency1, fee, tick_spacing, hooks FROM monad_v4_pool_directory WHERE pool_id = ?1",
  ).bind(poolId).first<V4KeyRow>();
}

export class PairError extends Error {
  constructor(readonly code: string, readonly status: 404 | 422) {
    super(code);
  }
}

/** Reads a pair live from the chain and checks it is the venue's canonical, active pool. */
export async function readPair(input: { client: MonadV3PoolClient; db: D1Database; venue: Venue; id: string;
  blockNumber?: bigint }): Promise<AnyPair> {
  const { client, venue, blockNumber } = input;
  if (venue === "uniswap-v3") {
    return readMonadV3Pool({ client, poolAddress: getAddress(input.id), blockNumber });
  }
  if (venue === "nadfun-v2") return readNadPair({ client, pairAddress: getAddress(input.id), blockNumber });
  const row = await v4KeyRow(input.db, input.id as Hex);
  if (!row) throw new PairError("POOL_NOT_INDEXED", 404);
  const pool = await readMonadV4Pool({ client, blockNumber, key: { currency0: getAddress(row.currency0),
    currency1: getAddress(row.currency1), fee: row.fee, tickSpacing: row.tick_spacing, hooks: getAddress(row.hooks) } });
  if (pool.id.toLowerCase() !== input.id.toLowerCase()) throw new PairError("POOL_ID_MISMATCH", 422);
  return pool;
}

/** Chain-read failures that mean "no such usable pool", as opposed to an RPC outage. */
export function pairReadRejection(error: unknown): { code: string; status: 404 | 422 } | null {
  if (error instanceof PairError) return { code: error.code, status: error.status };
  const message = error instanceof Error ? error.message : "";
  if (/^(?:POOL_|V4_POOL_|UNSUPPORTED_V4_POOL_KEY$|UNSUPPORTED_POOL_TOKEN$)/.test(message)) {
    return { code: message, status: 422 };
  }
  return null;
}

/** One Explore list row, whichever venue it came from. */
export type PairListItem = {
  venue: Venue;
  id: string;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  sqrtPriceX96: string | null;
  tick: number | null;
  /** Active liquidity for v3 and v4; LP total supply for nad.fun. */
  liquidity: string;
  reserve0: string | null;
  reserve1: string | null;
  memeToken: string | null;
  createdBlock: number | null;
  updatedAt: number | null;
};

export type ListedRow = {
  venue: Venue; id: string;
  token0_address: string; token0_symbol: string; token0_decimals: number;
  token1_address: string; token1_symbol: string; token1_decimals: number;
  fee: number | null; tick_spacing: number | null; hooks: string | null;
  sqrt_price_x96: string | null; tick: number | null; liquidity: string;
  reserve0: string | null; reserve1: string | null; meme_token: string | null;
  created_block: number | null; updated_at: number;
};

export function listItemFromRow(row: ListedRow): PairListItem {
  return {
    venue: row.venue, id: row.id,
    token0: { address: row.token0_address, symbol: row.token0_symbol, decimals: row.token0_decimals },
    token1: { address: row.token1_address, symbol: row.token1_symbol, decimals: row.token1_decimals },
    fee: row.fee, tickSpacing: row.tick_spacing, hooks: row.hooks, sqrtPriceX96: row.sqrt_price_x96,
    tick: row.tick, liquidity: row.liquidity, reserve0: row.reserve0, reserve1: row.reserve1,
    memeToken: row.meme_token, createdBlock: row.created_block, updatedAt: row.updated_at,
  };
}

export function listItemFromPair(pair: AnyPair): PairListItem {
  const common = { venue: pair.venue, id: pair.id, token0: pair.token0, token1: pair.token1,
    createdBlock: null, updatedAt: null };
  if (pair.venue === "nadfun-v2") {
    return { ...common, fee: null, tickSpacing: null, hooks: null, sqrtPriceX96: null, tick: null,
      liquidity: pair.totalSupply.toString(), reserve0: pair.reserve0.toString(),
      reserve1: pair.reserve1.toString(), memeToken: pair.memeToken };
  }
  return { ...common, fee: pair.fee, tickSpacing: pair.tickSpacing,
    hooks: pair.venue === "uniswap-v4" ? pair.hooks : null, sqrtPriceX96: pair.sqrtPriceX96.toString(),
    tick: pair.tick, liquidity: pair.liquidity.toString(), reserve0: null, reserve1: null, memeToken: null };
}
