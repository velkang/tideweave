import { MONAD_DELEGATED_RESERVE, MONAD_STABLES, MONAD_TOKENS, priceToTick, tickToPrice } from '@tideweave/chain'
import { zeroAddress } from 'viem'
import type { PairAssets, PairDetail, PairToken } from './explore-api'

// The deposit form's maths: ranges as prices, the paired amount, Max, and the swap that balances a
// one-sided wallet. Amounts are raw token units; v3 and v4 use the pool's current sqrt price.

export type Ticks = { tickLower: number; tickUpper: number }
export type RangePreset = 'wide' | 'balanced' | 'narrow' | 'full'

export const RANGE_PRESETS: ReadonlyArray<{ key: RangePreset; name: string; spread: number | null; label: string;
  hint: string }> = [
  { key: 'wide', name: 'Wide', spread: 0.25, label: 'Earns longer', hint: 'Keeps earning through big price swings, but earns less per trade.' },
  { key: 'balanced', name: 'Balanced', spread: 0.1, label: 'Recommended', hint: 'A good middle ground for most pairs.' },
  { key: 'narrow', name: 'Narrow', spread: 0.03, label: 'Earns more', hint: 'Earns the most per trade, but stops after small price moves.' },
  { key: 'full', name: 'Any price', spread: null, label: 'Never stops', hint: 'Never stops earning, but earns the least per trade.' },
]

const MAX_TICK = 887_272
/** MON kept for gas when MON itself is deposited or wrapped. */
export const GAS_BUFFER = 5n * 10n ** 17n
/** Holdings closer than this share of their value to the range's ratio need no swap. */
const BALANCED_SHARE = 0.005

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isNative = (token: PairToken) => same(token.address, zeroAddress)
const isWmon = (token: PairToken) => same(token.address, MONAD_TOKENS.WMON)

function quoteRank(token: PairToken) {
  if (MONAD_STABLES.some((stable) => same(stable, token.address))) return 3
  if (isNative(token) || isWmon(token)) return 2
  if (same(token.address, MONAD_TOKENS.WETH) || same(token.address, MONAD_TOKENS.WBTC)) return 1
  return 0
}

/** True when prices read best as token0 per token1: token0 is the better-known quote token. */
export function quoteFirst(pair: PairDetail) {
  return quoteRank(pair.token0) > quoteRank(pair.token1)
}

const flip = (price: number, inverted: boolean) => (inverted ? 1 / price : price)

/**
 * The direction prices read best in: priced in the better-known token when one side is a stablecoin, MON or a
 * major; otherwise whichever way gives a number of 1 or more ("1 xNVDA = 59.4M BLOBY", not "1.68e-8").
 */
export function readableInverted(pair: PairDetail) {
  const [rank0, rank1] = [quoteRank(pair.token0), quoteRank(pair.token1)]
  if (rank0 !== rank1) return rank0 > rank1
  const price = currentPrice(pair, false)
  return price > 0 && price < 1
}

/** Whole-unit price at a tick: token1 per token0, or the inverse. */
export function displayPrice(pair: PairDetail, tick: number, inverted: boolean) {
  return flip(tickToPrice(tick, pair.token0.decimals, pair.token1.decimals), inverted)
}

/** Raw token1 per raw token0 now. */
function rawPrice(pair: PairDetail) {
  if (pair.venue === 'nadfun-v2') {
    const [r0, r1] = [Number(pair.reserve0 ?? 0), Number(pair.reserve1 ?? 0)]
    return r0 > 0 ? r1 / r0 : 0
  }
  return (Number(pair.sqrtPriceX96 ?? 0) / 2 ** 96) ** 2
}

/** Whole-unit price now: token1 per token0, or the inverse. */
export function currentPrice(pair: PairDetail, inverted: boolean) {
  return flip(rawPrice(pair) * 10 ** (pair.token0.decimals - pair.token1.decimals), inverted)
}

function usableTicks(spacing: number) {
  return { low: Math.ceil(-MAX_TICK / spacing) * spacing, high: Math.floor(MAX_TICK / spacing) * spacing }
}

/** Ticks for a preset, always including the current price and aligned to the pool's spacing. */
export function presetTicks(pair: PairDetail, preset: RangePreset): Ticks {
  const spacing = pair.tickSpacing ?? 1
  const { low, high } = usableTicks(spacing)
  const spread = RANGE_PRESETS.find((entry) => entry.key === preset)?.spread ?? null
  if (spread === null) return { tickLower: low, tickUpper: high }
  const tick = pair.tick ?? 0
  const lower = Math.floor((tick + Math.log(1 - spread) / Math.log(1.0001)) / spacing) * spacing
  const upper = Math.ceil((tick + Math.log(1 + spread) / Math.log(1.0001)) / spacing) * spacing
  const aligned = Math.floor(tick / spacing) * spacing
  return { tickLower: Math.max(low, Math.min(lower, aligned)), tickUpper: Math.min(high, Math.max(upper, aligned + spacing)) }
}

/** Ticks for typed min and max prices, or null unless they form a range that includes the current price. */
export function customTicks(pair: PairDetail, minText: string, maxText: string, inverted: boolean): Ticks | null {
  const min = Number(minText)
  const max = Number(maxText)
  if (!minText.trim() || !maxText.trim() || !(min > 0) || !(max > min) || !Number.isFinite(max)) return null
  const [low, high] = inverted ? [1 / max, 1 / min] : [min, max]
  const spacing = pair.tickSpacing ?? 1
  const usable = usableTicks(spacing)
  const { decimals: d0 } = pair.token0
  const { decimals: d1 } = pair.token1
  const tickLower = Math.max(usable.low, Math.floor(priceToTick(low, d0, d1) / spacing) * spacing)
  const tickUpper = Math.min(usable.high, Math.ceil(priceToTick(high, d0, d1) / spacing) * spacing)
  const tick = pair.tick ?? 0
  return tickLower <= tick && tick < tickUpper ? { tickLower, tickUpper } : null
}

/** Raw token1 per raw token0 the range takes at today's price, or null when the range misses it. */
function depositRatio(pair: PairDetail, ticks: Ticks | null) {
  if (pair.venue === 'nadfun-v2' || !ticks) return null
  const sp = Number(pair.sqrtPriceX96 ?? 0) / 2 ** 96
  const sa = 1.0001 ** (ticks.tickLower / 2)
  const sb = 1.0001 ** (ticks.tickUpper / 2)
  if (!(sp > sa) || !(sp < sb)) return null
  return (sp * sb * (sp - sa)) / (sb - sp)
}

/** The other token's amount for `amount` of token `fromIndex`, or null when there is no ratio. */
export function pairedAmount(pair: PairDetail, ticks: Ticks | null, fromIndex: 0 | 1, amount: bigint): bigint | null {
  if (pair.venue === 'nadfun-v2') {
    const [r0, r1] = [BigInt(pair.reserve0 ?? 0), BigInt(pair.reserve1 ?? 0)]
    if (r0 === 0n || r1 === 0n) return null
    return fromIndex === 0 ? amount * r1 / r0 : amount * r0 / r1
  }
  const ratio = depositRatio(pair, ticks)
  if (ratio === null || !(ratio > 0)) return null
  const other = fromIndex === 0 ? Number(amount) * ratio : Number(amount) / ratio
  return Number.isFinite(other) ? BigInt(Math.floor(other)) : null
}

/** The largest deposit the two spendable balances allow at the range's ratio. */
export function maxDeposit(pair: PairDetail, ticks: Ticks | null, spendable: [bigint, bigint]): [bigint, bigint] {
  const [s0, s1] = spendable
  const for0 = pairedAmount(pair, ticks, 0, s0)
  if (for0 === null) return [0n, 0n]
  if (for0 <= s1) return [s0, for0]
  const for1 = pairedAmount(pair, ticks, 1, s1) ?? 0n
  return [for1 < s0 ? for1 : s0, s1]
}

/**
 * The swap that leaves holdings in the ratio the range takes at today's price, ignoring the swap's fee,
 * or null when they are close enough. `receiveIndex` is the token the swap buys.
 */
export function balancingSwap(pair: PairDetail, ticks: Ticks | null, held: [bigint, bigint]):
  { receiveIndex: 0 | 1; amountIn: bigint } | null {
  const price = rawPrice(pair)
  const [h0, h1] = [Number(held[0]), Number(held[1])]
  const total = h0 * price + h1
  if (!(price > 0) || !(total > 0)) return null
  let share1 = 0.5
  if (pair.venue !== 'nadfun-v2') {
    const ratio = depositRatio(pair, ticks)
    if (ratio === null) return null
    share1 = ratio / (price + ratio)
  }
  const excess1 = h1 - total * share1
  if (Math.abs(excess1) < total * BALANCED_SHARE) return null
  return excess1 > 0
    ? { receiveIndex: 0, amountIn: BigInt(Math.floor(excess1)) }
    : { receiveIndex: 1, amountIn: BigInt(Math.floor(-excess1 / price)) }
}

const atLeastZero = (value: bigint) => (value > 0n ? value : 0n)

/**
 * What each side can put in, keeping MON for gas (and Monad's 10 MON while the wallet is, or after a
 * nad.fun deposit will be, delegated). A nad.fun WMON side also counts MON the deposit can wrap.
 */
export function spendableBalances(pair: PairDetail, assets: PairAssets): { amounts: [bigint, bigint]; wrapLimit: bigint } {
  const delegated = pair.venue === 'nadfun-v2' || assets.delegate !== null
  const kept = GAS_BUFFER + (delegated ? MONAD_DELEGATED_RESERVE : 0n)
  const spareMon = atLeastZero(BigInt(assets.monBalance) - kept)
  const wrapLimit = pair.venue === 'nadfun-v2' ? spareMon : 0n
  const side = (token: PairToken & { balance: string }) => {
    if (isNative(token)) return spareMon
    return BigInt(token.balance) + (isWmon(token) ? wrapLimit : 0n)
  }
  return { amounts: [side(assets.token0), side(assets.token1)], wrapLimit }
}

/**
 * Whether 25/50/75/Max can do anything yet: the wallet holds both tokens and the range takes some of each.
 * Until then the form offers a way to get the tokens instead.
 */
export function quickAmountsReady(spendable: readonly [bigint, bigint] | null, max: readonly [bigint, bigint] | null) {
  return spendable !== null && max !== null && spendable[0] > 0n && spendable[1] > 0n && max[0] > 0n && max[1] > 0n
}
