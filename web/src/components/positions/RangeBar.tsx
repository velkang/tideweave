import { currentPrice, displayPrice } from '../../lib/deposit-math'
import type { PairDetail } from '../../lib/explore-api'
import { formatPrice } from '../../lib/format'
import { rangeBarLayout } from '../../lib/positions'

type Props = {
  pair: PairDetail
  range: { tickLower: number; tickUpper: number }
  inverted: boolean
  inRange: boolean
}

/** A position's price range on a bar, with a marker at today's price. */
export function RangeBar({ pair, range, inverted, inRange }: Props) {
  const prices = [displayPrice(pair, range.tickLower, inverted), displayPrice(pair, range.tickUpper, inverted)]
  const low = Math.min(...prices)
  const high = Math.max(...prices)
  const now = currentPrice(pair, inverted)
  const [base, quote] = inverted ? [pair.token1, pair.token0] : [pair.token0, pair.token1]
  const full = range.tickLower <= -880_000 && range.tickUpper >= 880_000
  const layout = full ? { start: 2, end: 98, marker: 50 } : rangeBarLayout({ low, high, now })
  const label = full ? 'any price' : `${formatPrice(low)} – ${formatPrice(high)}`
  return <div>
    <div className="relative h-3 rounded-full bg-tint" role="img"
      aria-label={`Range ${label} ${quote.symbol} per ${base.symbol}; price now ${formatPrice(now)}`}>
      <div className={`absolute inset-y-0 rounded-full ${inRange ? 'bg-feed' : 'bg-rest'}`}
        style={{ left: `${layout.start}%`, width: `${Math.max(1, layout.end - layout.start)}%` }} />
      <div className="absolute -top-1 h-5 w-1 -translate-x-1/2 rounded-full bg-ink" style={{ left: `${layout.marker}%` }} />
    </div>
    <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-xs tabular-nums text-ink-muted">
      <span>{full ? 'Full range' : `Range ${label}`}</span>
      <span>Now {formatPrice(now)} {quote.symbol} per {base.symbol}</span>
    </div>
  </div>
}
