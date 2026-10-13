import { describe, expect, it } from 'vitest'
import type { Position } from './explore-api'
import { formatUsd, hasFees, positionStatus, positionTotals, rangeBarLayout } from './positions'

const MON = { address: '0x0000000000000000000000000000000000000000', symbol: 'MON', decimals: 18 }
const GMON = { address: '0xBC19ac589C66e3661b8DcE5Caa29838279bD733A', symbol: 'MON.b.gMON', decimals: 18 }

function position(overrides: Partial<Position> = {}): Position {
  return { venue: 'uniswap-v4', id: '636714', liquidity: '1', range: { tickLower: -1280, tickUpper: -675 }, inRange: true,
    pool: { venue: 'uniswap-v4', id: `0x${'5f'.repeat(32)}`, token0: MON, token1: GMON, tick: -971, fee: 480,
      tickSpacing: 5, sqrtPriceX96: '0' },
    amounts: { amount0: '7097702373105114406', amount1: '6751257680543044090' }, fees: { amount0: '0', amount1: '0' },
    valueUsd: 0.3687, feesUsd: 0, transactionHash: null, ...overrides }
}

describe('position status', () => {
  it('is earning inside its range, and says which token it holds outside it', () => {
    expect(positionStatus(position())).toEqual({ kind: 'earning' })
    expect(positionStatus(position({ inRange: false, pool: { ...position().pool, tick: -2000 } })))
      .toEqual({ kind: 'out', holds: 'MON' })
    expect(positionStatus(position({ inRange: false, pool: { ...position().pool, tick: 0 } })))
      .toEqual({ kind: 'out', holds: 'MON.b.gMON' })
    expect(positionStatus(position({ venue: 'nadfun-v2', range: null }))).toEqual({ kind: 'any' })
  })
})

describe('range bar', () => {
  it('places the range and the price on one scale with room either side', () => {
    const layout = rangeBarLayout({ low: 0.88, high: 0.935, now: 0.907 })
    expect(layout.start).toBeGreaterThan(0)
    expect(layout.end).toBeLessThan(100)
    expect(layout.marker).toBeGreaterThan(layout.start)
    expect(layout.marker).toBeLessThan(layout.end)
  })

  it('keeps a price outside the range on the bar', () => {
    const below = rangeBarLayout({ low: 0.88, high: 0.935, now: 0.5 })
    expect(below.marker).toBeGreaterThanOrEqual(0)
    expect(below.marker).toBeLessThan(below.start)
    const above = rangeBarLayout({ low: 0.88, high: 0.935, now: 3 })
    expect(above.marker).toBeLessThanOrEqual(100)
    expect(above.marker).toBeGreaterThan(above.end)
  })
})

describe('totals', () => {
  it('adds up priced positions and counts the ones it could not price', () => {
    const totals = positionTotals([position({ valueUsd: 2, feesUsd: 0.5 }), position({ valueUsd: null, feesUsd: null }),
      position({ inRange: false, valueUsd: 1, feesUsd: null })])
    expect(totals).toEqual({ valueUsd: 3, feesUsd: 0.5, unpriced: 1, earning: 2, count: 3 })
  })

  it('knows when a position has fees to collect', () => {
    expect(hasFees(position())).toBe(false)
    expect(hasFees(position({ fees: { amount0: '1', amount1: '0' } }))).toBe(true)
    expect(hasFees(position({ fees: null }))).toBe(false)
  })
})

describe('dollars', () => {
  it('shows cents, and small amounts without rounding to zero', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0.3687)).toBe('$0.37')
    expect(formatUsd(0.0004)).toBe('< $0.01')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(null)).toBe('—')
  })
})
