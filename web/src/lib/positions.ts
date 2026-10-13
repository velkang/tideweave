import type { Position } from './explore-api'

// Pure helpers for the Positions page.

export type PositionStatus = { kind: 'earning' } | { kind: 'any' } | { kind: 'out'; holds: string }

/** Earning inside its range; outside it, a position holds only one token and earns nothing. */
export function positionStatus(position: Position): PositionStatus {
  if (!position.range) return { kind: 'any' }
  if (position.inRange) return { kind: 'earning' }
  const below = (position.pool.tick ?? 0) < position.range.tickLower
  return { kind: 'out', holds: (below ? position.pool.token0 : position.pool.token1).symbol }
}

const PADDING = 0.15

/** Percent offsets on one bar for a range and the current price, with room either side for a price outside it. */
export function rangeBarLayout({ low, high, now }: { low: number; high: number; now: number }) {
  const lo = Math.min(low, now)
  const hi = Math.max(high, now)
  const pad = (hi - lo) * PADDING || Math.abs(lo) * PADDING || 1
  const scale = (value: number) => ((value - (lo - pad)) / (hi - lo + 2 * pad)) * 100
  return { start: scale(low), end: scale(high), marker: scale(now) }
}

export function hasFees(position: Position) {
  return position.fees !== null && (BigInt(position.fees.amount0) > 0n || BigInt(position.fees.amount1) > 0n)
}

/** Dollar totals over the positions that could be priced, and how many could not. */
export function positionTotals(positions: Position[]) {
  return positions.reduce((totals, position) => ({
    valueUsd: totals.valueUsd + (position.valueUsd ?? 0),
    feesUsd: totals.feesUsd + (position.feesUsd ?? 0),
    unpriced: totals.unpriced + (position.valueUsd === null ? 1 : 0),
    earning: totals.earning + (position.inRange ? 1 : 0),
    count: totals.count + 1,
  }), { valueUsd: 0, feesUsd: 0, unpriced: 0, earning: 0, count: 0 })
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2,
  maximumFractionDigits: 2 })

export function formatUsd(value: number | null) {
  if (value === null) return '—'
  if (value > 0 && value < 0.01) return '< $0.01'
  return dollars.format(value)
}
