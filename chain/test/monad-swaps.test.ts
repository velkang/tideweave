import { decodeFunctionData, getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, NADFUN_MONAD, UNISWAP_V3_MONAD, UNISWAP_V4_MONAD, buildMonadSwap,
  buildSwapApproval, monadSwapPayloadHash, monadV4PoolId, nadRouterAbi, quoteMonadSwap, swapRouter02Abi,
  swapTokenOut, type MonadNadPair, type MonadV3Pool, type MonadV4Pool, type SwapQuoteClient } from "../src";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const meme = getAddress("0x7777777777777777777777777777777777777777");
const usdc = { address: MONAD_TOKENS.USDC, symbol: "USDC", decimals: 6 };
const wmon = { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18 };
const v3: MonadV3Pool = { chainId: MONAD_CHAIN_ID, venue: "uniswap-v3",
  id: getAddress("0x3333333333333333333333333333333333333333"), token0: wmon, token1: usdc, fee: 3000,
  tickSpacing: 60, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 10n ** 18n };
const v4Key = { currency0: zeroAddress, currency1: MONAD_TOKENS.USDC, fee: 500, tickSpacing: 10, hooks: zeroAddress };
const v4: MonadV4Pool = { chainId: MONAD_CHAIN_ID, venue: "uniswap-v4", id: monadV4PoolId(v4Key), ...v4Key,
  token0: { address: zeroAddress, symbol: "MON", decimals: 18 }, token1: usdc, sqrtPriceX96: 2n ** 96n, tick: 0,
  liquidity: 10n ** 18n, lpFee: 500 };
const nad: MonadNadPair = { chainId: MONAD_CHAIN_ID, venue: "nadfun-v2",
  id: getAddress("0x4444444444444444444444444444444444444444"), memeToken: meme, token0: wmon,
  token1: { address: meme, symbol: "MEME", decimals: 18 }, reserve0: 10n ** 22n, reserve1: 10n ** 25n,
  totalSupply: 10n ** 23n };
const limits = { amountIn: 1_000n, amountOutMinimum: 900n, recipient: wallet, deadline: 1_900_000_000n };

describe("building a swap for each venue", () => {
  it("sends a v3 swap through SwapRouter02 under a deadline, paying the wallet", () => {
    const swap = buildMonadSwap({ pair: v3, tokenIn: MONAD_TOKENS.WMON, ...limits });
    expect(swap).toMatchObject({ to: UNISWAP_V3_MONAD.swapRouter02, value: 0n, tokenOut: MONAD_TOKENS.USDC });
    const outer = decodeFunctionData({ abi: swapRouter02Abi, data: swap.data });
    expect(outer.functionName).toBe("multicall");
    expect(outer.args[0]).toBe(limits.deadline);
    const inner = decodeFunctionData({ abi: swapRouter02Abi, data: (outer.args[1] as `0x${string}`[])[0] });
    expect(inner.args[0]).toMatchObject({ tokenIn: MONAD_TOKENS.WMON, tokenOut: MONAD_TOKENS.USDC, fee: 3000,
      recipient: wallet, amountIn: 1_000n, amountOutMinimum: 900n });
  });

  it("sends a v4 swap through UniversalRouter, with value only when selling native MON", () => {
    expect(buildMonadSwap({ pair: v4, tokenIn: zeroAddress, ...limits })).toMatchObject({
      to: UNISWAP_V4_MONAD.universalRouter, value: 1_000n, tokenOut: MONAD_TOKENS.USDC });
    expect(buildMonadSwap({ pair: v4, tokenIn: MONAD_TOKENS.USDC, ...limits })).toMatchObject({ value: 0n,
      tokenOut: zeroAddress });
  });

  it("buys with WMON and sells the meme token through nad.fun's router", () => {
    const buy = buildMonadSwap({ pair: nad, tokenIn: MONAD_TOKENS.WMON, ...limits });
    const sell = buildMonadSwap({ pair: nad, tokenIn: meme, ...limits });
    expect(buy.to).toBe(NADFUN_MONAD.router);
    expect(decodeFunctionData({ abi: nadRouterAbi, data: buy.data })).toMatchObject({ functionName: "buy",
      args: [{ amountIn: 1_000n, amountOutMin: 900n, token: meme, to: wallet, deadline: limits.deadline }] });
    expect(decodeFunctionData({ abi: nadRouterAbi, data: sell.data }).functionName).toBe("sell");
  });

  it("refuses a token outside the pair and an empty or unbounded swap", () => {
    expect(() => swapTokenOut(v3, meme)).toThrow("SWAP_TOKEN_NOT_IN_PAIR");
    expect(() => buildMonadSwap({ pair: v3, tokenIn: MONAD_TOKENS.WMON, ...limits, amountOutMinimum: 0n }))
      .toThrow("SWAP_LIMITS_INVALID");
  });

  it("binds venue, router, value and calldata into the payload hash", () => {
    const swap = buildMonadSwap({ pair: v4, tokenIn: zeroAddress, ...limits });
    expect(monadSwapPayloadHash(swap)).not.toBe(monadSwapPayloadHash({ ...swap, value: 999n }));
  });
});

describe("approving a swap's input", () => {
  it("approves SwapRouter02 for v3 and nad.fun's router for nad.fun", () => {
    expect(buildSwapApproval({ pair: v3, token: MONAD_TOKENS.WMON, stage: "erc20", amount: 5n }))
      .toMatchObject({ to: MONAD_TOKENS.WMON, spender: UNISWAP_V3_MONAD.swapRouter02 });
    expect(buildSwapApproval({ pair: nad, token: meme, stage: "erc20", amount: 5n }))
      .toMatchObject({ to: meme, spender: NADFUN_MONAD.router });
  });

  it("approves Permit2, then UniversalRouter through Permit2, for v4", () => {
    expect(buildSwapApproval({ pair: v4, token: MONAD_TOKENS.USDC, stage: "erc20", amount: 5n }))
      .toMatchObject({ to: MONAD_TOKENS.USDC, spender: UNISWAP_V4_MONAD.permit2 });
    expect(buildSwapApproval({ pair: v4, token: MONAD_TOKENS.USDC, stage: "permit2", amount: 5n,
      expiration: 1_900_000_000n })).toMatchObject({ to: UNISWAP_V4_MONAD.permit2,
      spender: UNISWAP_V4_MONAD.universalRouter });
  });

  it("needs no approval for native MON, and no Permit2 stage outside v4", () => {
    expect(() => buildSwapApproval({ pair: v4, token: zeroAddress, stage: "erc20", amount: 5n }))
      .toThrow("NATIVE_NEEDS_NO_APPROVAL");
    expect(() => buildSwapApproval({ pair: v3, token: MONAD_TOKENS.WMON, stage: "permit2", amount: 5n,
      expiration: 1n })).toThrow("PERMIT2_NOT_USED");
  });
});

describe("quoting nad.fun price impact", () => {
  it("compares the quote with a thousandth of the amount, which carries the same fees", async () => {
    const client = { readContract: async ({ args }: { args: [Address, bigint, boolean] }) =>
      args[1] === 1_000_000n ? 900_000n : 900n } as unknown as SwapQuoteClient;
    // 1,000,000 in gives 900,000; at the reference rate it would give 900,000: no impact.
    expect(await quoteMonadSwap({ client, pair: nad, tokenIn: MONAD_TOKENS.WMON, amountIn: 1_000_000n }))
      .toEqual({ amountOut: 900_000n, priceImpactBps: 0 });
    const thin = { readContract: async ({ args }: { args: [Address, bigint, boolean] }) =>
      args[1] === 1_000_000n ? 450_000n : 900n } as unknown as SwapQuoteClient;
    expect((await quoteMonadSwap({ client: thin, pair: nad, tokenIn: MONAD_TOKENS.WMON, amountIn: 1_000_000n }))
      .priceImpactBps).toBe(5_000);
  });
});
