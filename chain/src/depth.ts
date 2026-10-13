import { getAddress, zeroAddress, type Address } from "viem";
import { MONAD_TOKENS } from "./monad";
import type { MonadV4Pool } from "./monad-v4-pool";
import type { MonadNadPair } from "./nadfun";
import { readMonadV3Pool, type MonadV3Pool, type MonadV3PoolClient } from "./pair-pool";

// A pool's price is only worth trusting, and depositing at, if moving it costs real money.
// Depth is what it takes to move the price 2%, priced in dollars through whichever side has a
// known price: a dollar stablecoin, or MON / WMON at the live MON price.

/** Pools that a few dollars can move 2% are almost empty. */
export const MIN_PAIR_DEPTH_USD = 5;
export const PRICE_MOVE = 0.02;

/** Dollar stablecoins on Monad (all 6 decimals; see MONAD_TOKENS). */
export const MONAD_STABLES: readonly Address[] = [MONAD_TOKENS.USDC, MONAD_TOKENS.USDT0, MONAD_TOKENS.AUSD];

/** Uniswap v3 WMON/USDC 0.3%, the deepest MON/USDC pool when this was written (2026-10-07). */
export const MON_USD_REFERENCE_POOL = getAddress("0x659bD0BC4167BA25c62E05656F78043E7eD4a9da");

type Token = { address: string; decimals: number };
export type DepthPair = {
  venue: "uniswap-v3" | "uniswap-v4" | "nadfun-v2";
  sqrtPriceX96?: string | null;
  liquidity?: string | null;
  reserve0?: string | null;
  reserve1?: string | null;
};

/**
 * Raw amounts of token0 and of token1 that move the price by `move`: from the liquidity at the
 * current price for v3 and v4, and from the reserves for a constant-product nad.fun pair.
 * Null when the pool has no price.
 */
export function moveAmounts(pair: DepthPair, move = PRICE_MOVE): [number, number] | null {
  const step = Math.sqrt(1 + move) - 1;
  if (pair.venue === "nadfun-v2") {
    const reserve0 = Number(pair.reserve0 ?? 0);
    const reserve1 = Number(pair.reserve1 ?? 0);
    return reserve0 > 0 && reserve1 > 0 ? [reserve0 * step, reserve1 * step] : null;
  }
  const sqrtPrice = Number(pair.sqrtPriceX96 ?? 0) / 2 ** 96;
  const liquidity = Number(pair.liquidity ?? 0);
  if (!(sqrtPrice > 0) || !(liquidity > 0)) return null;
  // token0 moves the price through 1/sqrtPrice, token1 through sqrtPrice.
  return [(liquidity / sqrtPrice) * step, liquidity * sqrtPrice * step];
}

/** Dollars per whole token, when known. */
export function usdPerToken(token: string, monUsd: number | null): number | null {
  const address = token.toLowerCase();
  if (MONAD_STABLES.some((stable) => stable.toLowerCase() === address)) return 1;
  if (address === zeroAddress || address === MONAD_TOKENS.WMON.toLowerCase()) return monUsd;
  return null;
}

/** Dollars that move the price 2% through its shallower priced side; null when neither side is priced. */
export function pairDepthUsd(pair: DepthPair & { token0: Token; token1: Token }, monUsd: number | null): number | null {
  const amounts = moveAmounts(pair);
  const sides = [pair.token0, pair.token1].map((token, index) => {
    const price = usdPerToken(token.address, monUsd);
    if (price === null) return null;
    return amounts ? (amounts[index] / 10 ** token.decimals) * price : 0;
  }).filter((usd): usd is number => usd !== null);
  return sides.length === 0 ? null : Math.min(...sides);
}

/**
 * True for a pool with no price, or one that a few dollars could move 2%. A pair neither of whose
 * tokens can be priced is not judged.
 */
export function isAlmostEmpty(pair: DepthPair & { token0: Token; token1: Token }, monUsd: number | null): boolean {
  if (moveAmounts(pair) === null) return true;
  const depth = pairDepthUsd(pair, monUsd);
  return depth !== null && depth < MIN_PAIR_DEPTH_USD;
}

/** The live MON price in dollars, from the reference WMON/USDC pool. */
export async function readMonUsd(client: MonadV3PoolClient, blockNumber?: bigint): Promise<number> {
  const pool = await readMonadV3Pool({ client, poolAddress: MON_USD_REFERENCE_POOL, blockNumber });
  const raw = (Number(pool.sqrtPriceX96) / 2 ** 96) ** 2; // raw token1 per raw token0
  const wmonIs0 = pool.token0.address === MONAD_TOKENS.WMON;
  if (!wmonIs0 && pool.token1.address !== MONAD_TOKENS.WMON) throw new Error("MON_USD_POOL_INVALID");
  const usdcPerWmon = wmonIs0 ? raw * 10 ** (pool.token0.decimals - pool.token1.decimals)
    : (1 / raw) * 10 ** (pool.token1.decimals - pool.token0.decimals);
  if (!(usdcPerWmon > 0) || !Number.isFinite(usdcPerWmon)) throw new Error("MON_USD_PRICE_INVALID");
  return usdcPerWmon;
}

/** isAlmostEmpty for a pool or pair read live from the chain. */
export function isLivePairAlmostEmpty(pair: MonadV3Pool | MonadV4Pool | MonadNadPair, monUsd: number | null): boolean {
  return isAlmostEmpty(pair.venue === "nadfun-v2"
    ? { venue: pair.venue, token0: pair.token0, token1: pair.token1, reserve0: pair.reserve0.toString(),
      reserve1: pair.reserve1.toString() }
    : { venue: pair.venue, token0: pair.token0, token1: pair.token1, sqrtPriceX96: pair.sqrtPriceX96.toString(),
      liquidity: pair.liquidity.toString() }, monUsd);
}
