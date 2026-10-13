import { formatUnits, getAddress, zeroAddress, type Address } from "viem";
import { MIN_PAIR_DEPTH_USD, MONAD_STABLES, MONAD_TOKENS, moveAmounts, readMonadV3Pool,
  readMonadV4Pool, readNadPair, usdPerToken, type MonadV3PoolClient, type TokenAmounts } from "@tideweave/chain";
import type { AnyPair, Venue } from "./pairs";

type Token = { address: string; decimals: number };
export type ValuationPool = { token0: Token; token1: Token; sqrtPriceX96?: bigint;
  liquidity?: bigint; reserve0?: bigint; reserve1?: bigint };
export type PriceRoute = { usd: number; depth: number; pools: string[] };
export type PriceCandidate = { venue: Venue; id: string; currency0?: Address; currency1?: Address;
  fee?: number; tick_spacing?: number; hooks?: Address };
type Dependencies = { candidates?: (token: Address, quotes: Address[]) => Promise<PriceCandidate[]>;
  read?: (candidate: PriceCandidate) => Promise<AnyPair> };

const ANCHORS = [...MONAD_STABLES, zeroAddress, MONAD_TOKENS.WMON];
const BRIDGES = [MONAD_TOKENS.WETH, MONAD_TOKENS.WBTC];
const valid = (price: number) => Number.isFinite(price) && price > 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function poolRatio(pool: ValuationPool) {
  const raw = pool.sqrtPriceX96 !== undefined ? (Number(pool.sqrtPriceX96) / 2 ** 96) ** 2
    : pool.reserve0 && pool.reserve1 ? Number(pool.reserve1) / Number(pool.reserve0) : 0;
  return raw * 10 ** (pool.token0.decimals - pool.token1.decimals);
}

function depth(pool: ValuationPool, side: 0 | 1, usd: number): number {
  const amounts = moveAmounts(pool.reserve0 !== undefined
    ? { venue: "nadfun-v2", reserve0: String(pool.reserve0), reserve1: String(pool.reserve1) }
    : { venue: "uniswap-v3", sqrtPriceX96: String(pool.sqrtPriceX96 ?? 0n), liquidity: String(pool.liquidity ?? 0n) });
  return amounts ? amounts[side] / 10 ** (side === 0 ? pool.token0.decimals : pool.token1.decimals) * usd : 0;
}

/** Stable ordering makes equally deep routes deterministic, independent of RPC completion order. */
export function bestRoute(routes: PriceRoute[]): PriceRoute | null {
  return routes.filter((route) => valid(route.usd) && valid(route.depth) && route.depth >= MIN_PAIR_DEPTH_USD)
    .sort((a, b) => b.depth - a.depth || a.pools.length - b.pools.length ||
      (a.pools.join("/") < b.pools.join("/") ? -1 : a.pools.join("/") > b.pools.join("/") ? 1 : 0))[0] ?? null;
}

const DIRECTORIES = [
  { venue: "uniswap-v3", table: "monad_v3_pool_directory", id: "pool_address", t0: "token0_address", t1: "token1_address", extra: "" },
  { venue: "uniswap-v4", table: "monad_v4_pool_directory", id: "pool_id", t0: "currency0", t1: "currency1",
    extra: ", currency0, currency1, fee, tick_spacing, hooks" },
  { venue: "nadfun-v2", table: "monad_nadfun_pair_directory", id: "pair_address", t0: "token0_address", t1: "token1_address", extra: "" },
] as const;

/** Four newest candidates per venue and counterpart, using the existing token indexes. */
export async function indexedPriceCandidates(db: D1Database, token: Address, quotes: Address[]): Promise<PriceCandidate[]> {
  const results = await Promise.all(DIRECTORIES.map(async (dir) => {
    const rows = await db.prepare(
      `SELECT * FROM (SELECT '${dir.venue}' AS venue, ${dir.id} AS id${dir.extra},
        ROW_NUMBER() OVER (PARTITION BY lower(CASE WHEN ${dir.t0} = ?1 THEN ${dir.t1} ELSE ${dir.t0} END)
          ORDER BY updated_at DESC, ${dir.id}) AS rank
       FROM ${dir.table}
       WHERE ((${dir.t0} = ?1 AND ${dir.t1} IN (SELECT value FROM json_each(?2)))
          OR (${dir.t1} = ?1 AND ${dir.t0} IN (SELECT value FROM json_each(?2))))
         ${dir.venue === "uniswap-v4" ? "AND hooks = '" + zeroAddress + "'" : ""}) WHERE rank <= 4`,
    ).bind(token, JSON.stringify(quotes)).all<PriceCandidate>();
    return rows.results;
  }));
  return results.flat();
}

/** Request-scoped display prices. Every pool read uses the same safe block; signing never calls this. */
export class UsdPriceResolver {
  private prices = new Map<string, Promise<PriceRoute | null>>()
  private pools = new Map<string, Promise<AnyPair | null>>()
  constructor(private db: D1Database, private client: MonadV3PoolClient, private blockNumber: bigint,
    private monUsd: number | null, private dependencies: Dependencies = {}) {}

  private anchor(token: string): PriceRoute | null {
    const usd = usdPerToken(token, this.monUsd);
    return usd !== null && valid(usd) ? { usd, depth: Infinity, pools: [] } : null;
  }

  price(token: string): Promise<PriceRoute | null> {
    const address = getAddress(token);
    if (ANCHORS.some((anchor) => same(anchor, address))) return Promise.resolve(this.anchor(address));
    const key = address.toLowerCase();
    let price = this.prices.get(key);
    if (!price) {
      price = this.resolve(address, !BRIDGES.some((bridge) => same(bridge, address))).catch(() => null);
      this.prices.set(key, price);
    }
    return price;
  }

  private async read(candidate: PriceCandidate): Promise<AnyPair | null> {
    const key = `${candidate.venue}:${candidate.id.toLowerCase()}`;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = (async () => {
        if (this.dependencies.read) return this.dependencies.read(candidate);
        const input = { client: this.client, blockNumber: this.blockNumber };
        if (candidate.venue === "uniswap-v3") return readMonadV3Pool({ ...input, poolAddress: getAddress(candidate.id) });
        if (candidate.venue === "nadfun-v2") return readNadPair({ ...input, pairAddress: getAddress(candidate.id) });
        const result = await readMonadV4Pool({ ...input, key: { currency0: candidate.currency0!, currency1: candidate.currency1!,
          fee: candidate.fee!, tickSpacing: candidate.tick_spacing!, hooks: candidate.hooks! } });
        if (!same(result.id, candidate.id)) throw new Error("POOL_ID_MISMATCH");
        return result;
      })().catch(() => null);
      this.pools.set(key, pool);
    }
    return pool;
  }

  private async resolve(token: Address, bridges: boolean): Promise<PriceRoute | null> {
    const quotes = [...ANCHORS, ...(bridges ? BRIDGES : [])].filter((quote) => !same(quote, token));
    const candidates = await (this.dependencies.candidates ?? ((t, q) => indexedPriceCandidates(this.db, t, q)))(token, quotes);
    const routes = await Promise.all(candidates.map(async (candidate) => {
      const pool = await this.read(candidate);
      if (!pool) return null;
      const tokenIs0 = same(pool.token0.address, token);
      if (!tokenIs0 && !same(pool.token1.address, token)) return null;
      const quote = tokenIs0 ? pool.token1.address : pool.token0.address;
      if (!quotes.some((allowed) => same(allowed, quote))) return null;
      const anchor = ANCHORS.some((allowed) => same(allowed, quote)) ? this.anchor(quote) : await this.price(quote);
      const ratio = poolRatio(pool);
      if (!anchor || !valid(ratio)) return null;
      const usd = tokenIs0 ? ratio * anchor.usd : anchor.usd / ratio;
      return { usd, depth: Math.min(depth(pool, tokenIs0 ? 1 : 0, anchor.usd), anchor.depth),
        pools: [`${candidate.venue}:${candidate.id.toLowerCase()}`, ...anchor.pools] };
    }));
    return bestRoute(routes.filter((route): route is PriceRoute => route !== null));
  }

  async value(pool: ValuationPool, amounts: TokenAmounts | null): Promise<number | null> {
    if (!amounts) return null;
    const resolved = await Promise.all([this.price(pool.token0.address), this.price(pool.token1.address)]);
    const prices = resolved.map((route) => route?.usd ?? null);
    // The own-pool fallback is permitted only against an anchor and sufficient live depth.
    const ratio = poolRatio(pool);
    for (const side of [0, 1] as const) {
      const other = side === 0 ? 1 : 0;
      const anchor = this.anchor(other === 0 ? pool.token0.address : pool.token1.address);
      if (prices[side] === null && anchor && valid(ratio) && depth(pool, other, anchor.usd) >= MIN_PAIR_DEPTH_USD)
        prices[side] = side === 0 ? anchor.usd * ratio : anchor.usd / ratio;
    }
    let total = 0;
    for (const side of [0, 1] as const) {
      const amount = side === 0 ? amounts.amount0 : amounts.amount1;
      if (amount === 0n) continue;
      if (prices[side] === null) return null;
      total += Number(formatUnits(amount, side === 0 ? pool.token0.decimals : pool.token1.decimals)) * prices[side]!;
    }
    return Number.isFinite(total) ? total : null;
  }
}
