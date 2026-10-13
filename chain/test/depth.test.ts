import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MIN_PAIR_DEPTH_USD, MONAD_TOKENS, isAlmostEmpty, moveAmounts, pairDepthUsd } from "../src";

const meme = { address: getAddress("0x7777777777777777777777777777777777777777"), decimals: 18 };
const other = { address: getAddress("0x8888888888888888888888888888888888888888"), decimals: 18 };
const usdc = { address: MONAD_TOKENS.USDC, decimals: 6 };
const wmon = { address: MONAD_TOKENS.WMON, decimals: 18 };
const mon = { address: zeroAddress, decimals: 18 };
const STEP = Math.sqrt(1.02) - 1;
const Q96 = 2n ** 96n;

describe("how much it takes to move a pair's price 2%", () => {
  it("uses the liquidity at the current price for v3 and v4", () => {
    const [amount0, amount1] = moveAmounts({ venue: "uniswap-v3", sqrtPriceX96: (Q96 * 2n).toString(),
      liquidity: "1000000" })!;
    expect(amount0).toBeCloseTo((1_000_000 / 2) * STEP);
    expect(amount1).toBeCloseTo(1_000_000 * 2 * STEP);
  });

  it("uses the reserves for a nad.fun pair", () => {
    const [amount0, amount1] = moveAmounts({ venue: "nadfun-v2", reserve0: "4000", reserve1: "9000" })!;
    expect(amount0).toBeCloseTo(4000 * STEP);
    expect(amount1).toBeCloseTo(9000 * STEP);
  });

  it("has no answer for a pool without a price or reserves", () => {
    expect(moveAmounts({ venue: "uniswap-v4", sqrtPriceX96: "0", liquidity: "5" })).toBeNull();
    expect(moveAmounts({ venue: "nadfun-v2", reserve0: "0", reserve1: "5" })).toBeNull();
  });
});

describe("pricing that depth in dollars", () => {
  // At sqrtPrice 1, moving 2% takes L * STEP raw units of either token.
  const flat = (liquidity: bigint) => ({ sqrtPriceX96: Q96.toString(), liquidity: liquidity.toString() });

  it("prices a stablecoin side at one dollar, whichever side it is", () => {
    const pair = { venue: "uniswap-v3" as const, token0: usdc, token1: meme, ...flat(100_000_000n) };
    expect(pairDepthUsd(pair, null)).toBeCloseTo(100 * STEP);
    expect(pairDepthUsd({ ...pair, token0: meme, token1: usdc }, null)).toBeCloseTo(100 * STEP);
  });

  it("prices MON and WMON at the live MON price, and needs that price", () => {
    const native = { venue: "uniswap-v4" as const, token0: mon, token1: meme, ...flat(10n ** 20n) };
    expect(pairDepthUsd(native, 0.5)).toBeCloseTo(100 * STEP * 0.5);
    expect(pairDepthUsd(native, null)).toBeNull();
    const nad = { venue: "nadfun-v2" as const, token0: wmon, token1: meme, reserve0: (10n ** 21n).toString(),
      reserve1: "1" };
    expect(pairDepthUsd(nad, 0.02)).toBeCloseTo(1000 * STEP * 0.02);
  });

  it("takes the shallower side when both are priced", () => {
    // 1 MON = $2 here, and the pool holds far less USDC-side depth than MON-side.
    const pair = { venue: "uniswap-v3" as const, token0: usdc, token1: wmon,
      sqrtPriceX96: (Q96 * 1_000_000n).toString(), liquidity: (10n ** 12n).toString() };
    const [amount0, amount1] = moveAmounts(pair)!;
    expect(pairDepthUsd(pair, 2)).toBeCloseTo(Math.min(amount0 / 1e6, (amount1 / 1e18) * 2));
  });

  it("cannot price a pair of two unknown tokens", () => {
    expect(pairDepthUsd({ venue: "uniswap-v3", token0: meme, token1: other, ...flat(10n ** 30n) }, 1)).toBeNull();
  });
});

describe("almost-empty pools", () => {
  it("is below a few dollars of depth, or has no price at all", () => {
    const pair = (liquidity: bigint) => ({ venue: "uniswap-v3" as const, token0: usdc, token1: meme,
      sqrtPriceX96: Q96.toString(), liquidity: liquidity.toString() });
    const dollars = (usd: number) => BigInt(Math.ceil((usd / STEP) * 1e6));
    expect(isAlmostEmpty(pair(dollars(MIN_PAIR_DEPTH_USD / 2)), null)).toBe(true);
    expect(isAlmostEmpty(pair(dollars(MIN_PAIR_DEPTH_USD * 2)), null)).toBe(false);
    expect(isAlmostEmpty({ ...pair(10n ** 9n), sqrtPriceX96: "0" }, null)).toBe(true);
  });

  it("does not judge a pair it cannot price", () => {
    expect(isAlmostEmpty({ venue: "uniswap-v3", token0: meme, token1: other, sqrtPriceX96: Q96.toString(),
      liquidity: "1" }, 1)).toBe(false);
  });
});
