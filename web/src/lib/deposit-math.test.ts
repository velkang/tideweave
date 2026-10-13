import { describe, expect, it } from 'vitest'
import type { PairAssets, PairDetail } from './explore-api'
import { balancingSwap, quickAmountsReady, currentPrice, customTicks, displayPrice, maxDeposit, pairedAmount, presetTicks, quoteFirst,
  readableInverted, spendableBalances } from './deposit-math'

const WMON = { address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', symbol: 'WMON', decimals: 18 }
const USDC = { address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', symbol: 'USDC', decimals: 6 }
const MON = { address: '0x0000000000000000000000000000000000000000', symbol: 'MON', decimals: 18 }
const MEME = { address: '0x1111111111111111111111111111111111111111', symbol: 'MEME', decimals: 18 }
const ONE = 10n ** 18n

// A price exactly on a tick: 1.0001^-311400 raw USDC per raw WMON, about 0.0297 USDC per WMON.
const TICK = -311_400
const sqrtAt = (tick: number) => BigInt(Math.round(1.0001 ** (tick / 2) * 2 ** 96)).toString()
const v3: PairDetail = { venue: 'uniswap-v3', id: '0x3333333333333333333333333333333333333333', token0: WMON,
  token1: USDC, fee: 3000, tickSpacing: 60, tick: TICK, sqrtPriceX96: sqrtAt(TICK) }
const nad: PairDetail = { venue: 'nadfun-v2', id: '0x5555555555555555555555555555555555555555', token0: MEME,
  token1: WMON, reserve0: (2_000n * ONE).toString(), reserve1: (1_000n * ONE).toString() }
const symmetric = { tickLower: TICK - 600, tickUpper: TICK + 600 }

function assets(pair: PairDetail, balance0: bigint, balance1: bigint, mon: bigint, delegate: string | null = null): PairAssets {
  return { venue: pair.venue, id: pair.id, walletAddress: '0x9999999999999999999999999999999999999999',
    token0: { ...pair.token0, balance: balance0.toString() }, token1: { ...pair.token1, balance: balance1.toString() },
    monBalance: mon.toString(), delegate, approvals: [] }
}

describe('price ranges', () => {
  it('builds a preset range around the current price, aligned to the tick spacing', () => {
    const ticks = presetTicks(v3, 'balanced')
    expect(Math.abs(ticks.tickLower % 60)).toBe(0)
    expect(Math.abs(ticks.tickUpper % 60)).toBe(0)
    expect(ticks.tickLower).toBeLessThanOrEqual(TICK)
    expect(ticks.tickUpper).toBeGreaterThan(TICK)
    const price = currentPrice(v3, false)
    expect(displayPrice(v3, ticks.tickLower, false) / price).toBeCloseTo(0.9, 1)
    expect(displayPrice(v3, ticks.tickUpper, false) / price).toBeCloseTo(1.1, 1)
  })

  it('uses the widest usable ticks for a full range', () => {
    expect(presetTicks(v3, 'full')).toEqual({ tickLower: -887_220, tickUpper: 887_220 })
  })

  it('keeps a narrow range at least one spacing either side of the price', () => {
    const wide = { ...v3, tickSpacing: 200 }
    const ticks = presetTicks(wide, 'narrow')
    expect(ticks.tickLower).toBeLessThanOrEqual(TICK)
    expect(ticks.tickUpper).toBeGreaterThan(TICK)
  })

  it('shows prices in the quote token: a stablecoin, then MON', () => {
    expect(quoteFirst(v3)).toBe(false)
    expect(quoteFirst({ ...v3, token0: USDC, token1: MEME })).toBe(true)
    expect(quoteFirst({ ...v3, token0: MON, token1: MEME })).toBe(true)
    expect(quoteFirst({ ...v3, token0: MON, token1: USDC })).toBe(false)
    expect(currentPrice(v3, false)).toBeCloseTo(1.0001 ** TICK * 1e12, 6)
    expect(currentPrice(v3, true)).toBeCloseTo(1 / (1.0001 ** TICK * 1e12), 3)
  })

  it('turns typed prices into ticks that include the current price', () => {
    const price = currentPrice(v3, false)
    const ticks = customTicks(v3, String(price * 0.8), String(price * 1.2), false)!
    expect(ticks.tickLower).toBeLessThanOrEqual(TICK)
    expect(ticks.tickUpper).toBeGreaterThan(TICK)
    const inverted = currentPrice(v3, true)
    const flipped = customTicks(v3, String(inverted * 0.8), String(inverted * 1.2), true)!
    expect(flipped.tickLower).toBeLessThanOrEqual(TICK)
    expect(flipped.tickUpper).toBeGreaterThan(TICK)
  })

  it('rejects a typed range that is empty, reversed or misses the current price', () => {
    const price = currentPrice(v3, false)
    expect(customTicks(v3, String(price * 1.1), String(price * 1.2), false)).toBeNull()
    expect(customTicks(v3, String(price * 1.2), String(price * 0.8), false)).toBeNull()
    expect(customTicks(v3, '', '1', false)).toBeNull()
    expect(customTicks(v3, 'abc', '1', false)).toBeNull()
  })
})

describe('amounts', () => {
  it('fills the other side at the range ratio: equal value for a range centred on the price', () => {
    const usdc = pairedAmount(v3, symmetric, 0, 100n * ONE)!
    expect(Number(usdc) / (100 * 1.0001 ** TICK * 1e18)).toBeCloseTo(1, 6)
    const back = pairedAmount(v3, symmetric, 1, usdc)!
    expect(Number(back) / 1e20).toBeCloseTo(1, 5)
  })

  it('fills the other side of a nad.fun pair from its reserves', () => {
    expect(pairedAmount(nad, null, 0, 10n * ONE)).toBe(5n * ONE)
    expect(pairedAmount(nad, null, 1, 5n * ONE)).toBe(10n * ONE)
  })

  it('has no pairing when the range misses the price', () => {
    expect(pairedAmount(v3, { tickLower: TICK + 60, tickUpper: TICK + 600 }, 0, ONE)).toBeNull()
  })

  it('uses as much as the smaller side allows for Max', () => {
    // 20 MEME pairs with 10 WMON; with only 4 WMON, Max is 8 MEME + 4 WMON.
    expect(maxDeposit(nad, null, [20n * ONE, 4n * ONE])).toEqual([8n * ONE, 4n * ONE])
    expect(maxDeposit(nad, null, [6n * ONE, 40n * ONE])).toEqual([6n * ONE, 3n * ONE])
    const [a0, a1] = maxDeposit(v3, symmetric, [100n * ONE, 1_000_000n])
    expect(a0).toBeLessThanOrEqual(100n * ONE)
    expect(a1).toBeLessThanOrEqual(1_000_000n)
    expect(a1 === 1_000_000n || a0 === 100n * ONE).toBe(true)
  })
})

describe('balancing with a swap', () => {
  it('sells about half of a single token for a range centred on the price', () => {
    const swap = balancingSwap(v3, symmetric, [1_000n * ONE, 0n])!
    expect(swap.receiveIndex).toBe(1)
    expect(Number(swap.amountIn) / 1e21).toBeCloseTo(0.5, 3)
    const other = balancingSwap(nad, null, [0n, 10n * ONE])!
    expect(other).toEqual({ receiveIndex: 0, amountIn: 5n * ONE })
  })

  it('needs no swap when the holdings already match', () => {
    expect(balancingSwap(nad, null, [20n * ONE, 10n * ONE])).toBeNull()
    expect(balancingSwap(nad, null, [0n, 0n])).toBeNull()
  })
})

describe('spendable balances', () => {
  it('keeps MON for gas on a native-MON side', () => {
    const pair: PairDetail = { ...v3, venue: 'uniswap-v4', token0: MON, token1: USDC }
    expect(spendableBalances(pair, assets(pair, 5n * ONE, 7n, 5n * ONE))).toEqual({ amounts: [45n * ONE / 10n, 7n],
      wrapLimit: 0n })
  })

  it('keeps 10 MON on a delegated wallet', () => {
    const pair: PairDetail = { ...v3, venue: 'uniswap-v4', token0: MON, token1: USDC }
    const held = assets(pair, 12n * ONE, 7n, 12n * ONE, '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9')
    expect(spendableBalances(pair, held).amounts[0]).toBe(15n * ONE / 10n)
  })

  it('counts MON above the 10 MON reserve as WMON a nad.fun deposit can wrap', () => {
    const held = assets(nad, 3n * ONE, 2n * ONE, 13n * ONE)
    expect(spendableBalances(nad, held)).toEqual({ amounts: [3n * ONE, 45n * ONE / 10n], wrapLimit: 25n * ONE / 10n })
    expect(spendableBalances(nad, assets(nad, 3n * ONE, 2n * ONE, 9n * ONE))).toEqual({ amounts: [3n * ONE, 2n * ONE],
      wrapLimit: 0n })
  })
})

describe('which way prices read', () => {
  const OTHER = { address: '0x2222222222222222222222222222222222222222', symbol: 'OTHER', decimals: 18 }
  // 1 MEME is worth about 1.7e-8 OTHER: the readable direction is OTHER priced in MEME.
  const tiny = -178_000
  const unknown: PairDetail = { venue: 'uniswap-v3', id: '0x4444444444444444444444444444444444444444', token0: MEME,
    token1: OTHER, fee: 10_000, tickSpacing: 200, tick: tiny, sqrtPriceX96: sqrtAt(tiny) }

  it('prices in the better-known token when there is one', () => {
    expect(readableInverted(v3)).toBe(quoteFirst(v3))
  })

  it('otherwise flips a tiny price so it reads as a number above 1', () => {
    expect(currentPrice(unknown, false)).toBeLessThan(1e-7)
    expect(readableInverted(unknown)).toBe(true)
    expect(currentPrice(unknown, true)).toBeGreaterThan(1)
  })
})

describe('when quick amounts show', () => {
  it('only once the wallet holds both tokens and the range can take some of each', () => {
    expect(quickAmountsReady([5n, 7n], [5n, 3n])).toBe(true)
    expect(quickAmountsReady([0n, 7n], [0n, 0n])).toBe(false)
    expect(quickAmountsReady([5n, 0n], [0n, 0n])).toBe(false)
    expect(quickAmountsReady([5n, 7n], [0n, 0n])).toBe(false)
    expect(quickAmountsReady(null, null)).toBe(false)
  })
})
