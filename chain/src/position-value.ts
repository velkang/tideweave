import { decodeFunctionResult, encodeFunctionData, formatUnits, maxUint128, maxUint256, numberToHex, parseAbi,
  type Address, type Hex } from "viem";
import { usdPerToken } from "./depth";
import { UNISWAP_V3_MONAD, UNISWAP_V4_MONAD } from "./monad";

// What a position holds now, the fees it has earned but not collected, and what that is worth.

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;
const MAX_TICK = 887272;
const TWO_256 = maxUint256 + 1n;

// Uniswap's TickMath.getSqrtRatioAtTick: sqrt(1.0001^tick) * 2^96, exactly as the pools compute it.
const TICK_FACTORS: ReadonlyArray<readonly [bigint, bigint]> = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > MAX_TICK) throw new Error("TICK_OUT_OF_RANGE");
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, factor] of TICK_FACTORS) {
    if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = maxUint256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

export type TokenAmounts = { amount0: bigint; amount1: bigint };

/** The tokens a position's liquidity is worth at the pool's current price, rounded down as a withdrawal would be. */
export function amountsForLiquidity(input: { sqrtPriceX96: bigint; tickLower: number; tickUpper: number;
  liquidity: bigint }): TokenAmounts {
  const lower = getSqrtRatioAtTick(input.tickLower);
  const upper = getSqrtRatioAtTick(input.tickUpper);
  const price = input.sqrtPriceX96 < lower ? lower : input.sqrtPriceX96 > upper ? upper : input.sqrtPriceX96;
  const amount0 = price < upper ? ((input.liquidity << 96n) * (upper - price) / upper) / price : 0n;
  const amount1 = price > lower ? input.liquidity * (price - lower) / Q96 : 0n;
  return { amount0, amount1 };
}

const v3CollectAbi = parseAbi([
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
]);

export type FeeCallClient = {
  call(input: { account: Address; to: Address; data: Hex; blockNumber?: bigint }): Promise<{ data?: Hex }>;
};

/**
 * Everything a v3 position can collect now: earned fees plus anything owed from a decrease. Read by simulating
 * a collect from the owner, which settles the fees first, exactly as a real collect would.
 */
export async function readV3Fees(input: { client: FeeCallClient; tokenId: bigint; owner: Address;
  blockNumber?: bigint }): Promise<TokenAmounts> {
  const { data } = await input.client.call({ account: input.owner, to: UNISWAP_V3_MONAD.nonfungiblePositionManager,
    data: encodeFunctionData({ abi: v3CollectAbi, functionName: "collect", args: [{ tokenId: input.tokenId,
      recipient: input.owner, amount0Max: maxUint128, amount1Max: maxUint128 }] }), blockNumber: input.blockNumber });
  if (!data) throw new Error("V3_FEES_UNAVAILABLE");
  const [amount0, amount1] = decodeFunctionResult({ abi: v3CollectAbi, functionName: "collect", data });
  return { amount0, amount1 };
}

const stateViewAbi = parseAbi([
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
]);

export type StateViewClient = {
  readContract(input: { address: Address; abi: typeof stateViewAbi; functionName: string; args: readonly unknown[];
    blockNumber?: bigint }): Promise<unknown>;
};

/**
 * A v4 position's earned, uncollected fees: fee growth inside its range since it last settled, times its
 * liquidity. Fee growth wraps at 2^256, as in the pool contract.
 */
export async function readV4Fees(input: { client: StateViewClient; poolId: Hex; tokenId: bigint; tickLower: number;
  tickUpper: number; blockNumber?: bigint }): Promise<TokenAmounts> {
  const read = (functionName: string, args: readonly unknown[]) => input.client.readContract({
    address: UNISWAP_V4_MONAD.stateView, abi: stateViewAbi, functionName, args, blockNumber: input.blockNumber });
  // The position manager owns every v4 position; each is told apart by its token id as the salt.
  const salt = numberToHex(input.tokenId, { size: 32 });
  const [info, inside] = await Promise.all([
    read("getPositionInfo", [input.poolId, UNISWAP_V4_MONAD.positionManager, input.tickLower, input.tickUpper, salt]),
    read("getFeeGrowthInside", [input.poolId, input.tickLower, input.tickUpper]),
  ]) as [readonly [bigint, bigint, bigint], readonly [bigint, bigint]];
  const [liquidity, last0, last1] = info;
  const earned = (now: bigint, last: bigint) => (((now - last) % TWO_256 + TWO_256) % TWO_256) * liquidity / Q128;
  return { amount0: earned(inside[0], last0), amount1: earned(inside[1], last1) };
}

type PricedToken = { address: string; decimals: number };

/**
 * Dollars for an amount of each token. A side with no known price is priced through the pool's own price
 * against the other side; null when neither side is known.
 */
export function positionUsd(pool: { token0: PricedToken; token1: PricedToken; priceToken1PerToken0: number },
  amounts: TokenAmounts, monUsd: number | null): number | null {
  let usd0 = usdPerToken(pool.token0.address, monUsd);
  let usd1 = usdPerToken(pool.token1.address, monUsd);
  const price = pool.priceToken1PerToken0;
  if (usd0 === null && usd1 !== null && price > 0) usd0 = usd1 * price;
  if (usd1 === null && usd0 !== null && price > 0) usd1 = usd0 / price;
  if (usd0 === null || usd1 === null) return null;
  const whole = (amount: bigint, decimals: number) => Number(formatUnits(amount, decimals));
  return whole(amounts.amount0, pool.token0.decimals) * usd0 + whole(amounts.amount1, pool.token1.decimals) * usd1;
}
