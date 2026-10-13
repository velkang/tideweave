import { encodeFunctionResult, parseAbi, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, UNISWAP_V4_MONAD } from "../src/monad";
import { amountsForLiquidity, getSqrtRatioAtTick, positionUsd, readV3Fees, readV4Fees } from "../src/position-value";

const Q96 = 2n ** 96n;

describe("tick maths", () => {
  it("matches Uniswap's TickMath at the ends and the middle", () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
    expect(getSqrtRatioAtTick(-887272)).toBe(4295128739n);
    expect(getSqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n);
    expect(() => getSqrtRatioAtTick(887273)).toThrow("TICK_OUT_OF_RANGE");
  });

  it("is close to 1.0001^(tick/2) in between", () => {
    for (const tick of [-971, -311_400, 60, 200_000]) {
      const exact = Number(getSqrtRatioAtTick(tick)) / 2 ** 96;
      expect(exact / 1.0001 ** (tick / 2)).toBeCloseTo(1, 9);
    }
  });
});

describe("amounts a position holds", () => {
  const liquidity = 10n ** 18n;
  it("holds both tokens in range", () => {
    const amounts = amountsForLiquidity({ sqrtPriceX96: Q96, tickLower: -600, tickUpper: 600, liquidity });
    const float0 = 1e18 * (1 - 1.0001 ** -300);
    expect(Number(amounts.amount0) / float0).toBeCloseTo(1, 6);
    expect(Number(amounts.amount1) / float0).toBeCloseTo(1, 6);
  });

  it("holds only token0 below the range and only token1 above it", () => {
    const below = amountsForLiquidity({ sqrtPriceX96: getSqrtRatioAtTick(-1000), tickLower: -600, tickUpper: 600, liquidity });
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);
    const above = amountsForLiquidity({ sqrtPriceX96: getSqrtRatioAtTick(1000), tickLower: -600, tickUpper: 600, liquidity });
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
  });
});

describe("uncollected fees", () => {
  const owner = "0x90e242E0ABc00Eb8bceBe3Eb91a9B0AE7e7799ef" as Address;

  it("reads v3 fees by simulating a collect from the owner", async () => {
    const collectAbi = parseAbi(["function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)"]);
    const calls: unknown[] = [];
    const client = { call: async (input: unknown) => { calls.push(input);
      return { data: encodeFunctionResult({ abi: collectAbi, functionName: "collect", result: [5n, 7n] }) }; } };
    expect(await readV3Fees({ client, tokenId: 9n, owner, blockNumber: 100n })).toEqual({ amount0: 5n, amount1: 7n });
    expect(calls[0]).toMatchObject({ account: owner, blockNumber: 100n });
  });

  it("reads v4 fees from fee growth since the position last settled, wrapping like Solidity", async () => {
    const MAX = 2n ** 256n;
    const client = { readContract: async ({ address, functionName, args }: { address: Address; functionName: string;
      args: readonly unknown[] }) => {
      expect(address).toBe(UNISWAP_V4_MONAD.stateView);
      if (functionName === "getPositionInfo") {
        expect(args[1]).toBe(UNISWAP_V4_MONAD.positionManager);
        expect(args[4]).toBe(`0x${"0".repeat(62)}09`);
        return [10n ** 18n, MAX - 2n ** 128n, 0n];
      }
      return [2n ** 128n, 3n * 2n ** 128n];
    } };
    // token0's growth wrapped past 2^256: 2^128 - (2^256 - 2^128) = 2 * 2^128 mod 2^256.
    const fees = await readV4Fees({ client, poolId: `0x${"ab".repeat(32)}`, tokenId: 9n, tickLower: -60, tickUpper: 60,
      blockNumber: 100n });
    expect(fees).toEqual({ amount0: 2n * 10n ** 18n, amount1: 3n * 10n ** 18n });
  });
});

describe("dollar value", () => {
  const usdc = { address: MONAD_TOKENS.USDC, symbol: "USDC", decimals: 6 };
  const wmon = { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18 };
  const meme = { address: "0x1111111111111111111111111111111111111111" as Address, symbol: "MEME", decimals: 18 };
  const mon = { address: zeroAddress, symbol: "MON", decimals: 18 };

  it("prices both sides directly when it can", () => {
    expect(positionUsd({ token0: wmon, token1: usdc, priceToken1PerToken0: 0.03 },
      { amount0: 100n * 10n ** 18n, amount1: 2_000_000n }, 0.03)).toBeCloseTo(5, 9);
  });

  it("prices an unknown side through the pool's price", () => {
    // 1 MEME = 2 MON at $0.03: 10 MEME + 5 MON = 25 MON = $0.75.
    expect(positionUsd({ token0: mon, token1: meme, priceToken1PerToken0: 0.5 },
      { amount0: 5n * 10n ** 18n, amount1: 10n * 10n ** 18n }, 0.03)).toBeCloseTo(0.75, 9);
  });

  it("is null when neither side can be priced", () => {
    expect(positionUsd({ token0: meme, token1: { ...meme, address: "0x2222222222222222222222222222222222222222" },
      priceToken1PerToken0: 1 }, { amount0: 1n, amount1: 1n }, 0.03)).toBeNull();
    expect(positionUsd({ token0: wmon, token1: meme, priceToken1PerToken0: 1 }, { amount0: 1n, amount1: 1n }, null))
      .toBeNull();
  });
});
