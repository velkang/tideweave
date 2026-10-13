import { quoteFirst } from '../../lib/deposit-math'
import type { Position } from '../../lib/explore-api'
import { formatToken, formatFee, short, VENUE_LABEL } from '../../lib/format'
import { formatUsd, hasFees, positionStatus } from '../../lib/positions'
import { VENUES } from '../../lib/venues'
import { badge, button, secondary } from '../explore/ui'
import { RangeBar } from './RangeBar'

type Props = {
  position: Position
  busy: boolean
  onCollect: () => void
  onRemove: () => void
  automationStatus?: string
  onAutomation?: () => void
  onAddMore: () => void
}

const EXPLORER = 'https://monadscan.com'

function StatusPill({ position }: { position: Position }) {
  const status = positionStatus(position)
  const [text, className] = status.kind === 'out'
    ? [`Not earning: holds only ${status.holds}`, 'border-rest-line bg-rest-soft text-rest']
    : [status.kind === 'any' ? 'Earning at any price' : 'Earning', 'border-feed-line bg-feed-soft text-feed']
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${className}`}>
    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{text}</span>
}

/** One position: its state, what it holds, its fees, and what can be done with it. */
export function PositionCard({ position, busy, onCollect, onRemove, onAddMore, onAutomation, automationStatus }: Props) {
  const { pool } = position
  const adapter = VENUES[position.venue]
  const pair = (amounts: { amount0: string; amount1: string }) =>
    `${formatToken(amounts.amount0, pool.token0.decimals)} ${pool.token0.symbol} + ${formatToken(amounts.amount1, pool.token1.decimals)} ${pool.token1.symbol}`
  const collectable = hasFees(position)
  const status = positionStatus(position)

  return <article className="rounded-[20px] border border-line bg-card p-5" aria-labelledby={`position-${position.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 id={`position-${position.id}`} className="text-xl font-semibold">{pool.token0.symbol} / {pool.token1.symbol}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <span className={badge}>{VENUE_LABEL[position.venue]}</span>
          <span>{formatFee(pool.fee)}</span>
          <span>{position.range ? `NFT #${position.id}` : short(position.id)}</span>
          {position.transactionHash ? <a className="text-link underline-offset-4 hover:underline" target="_blank" rel="noreferrer"
            href={`${EXPLORER}/tx/${position.transactionHash}`}>Opened ↗</a> : null}
        </p>
      </div>
      <StatusPill position={position} />
    </div>

    {position.range ? <div className="mt-4"><RangeBar pair={pool} range={position.range} inverted={quoteFirst(pool)}
      inRange={position.inRange} /></div> : null}
    {status.kind === 'out' ? <p className="mt-2 text-sm text-ink-muted">The price left this range, so the position stopped earning. It earns again if the price comes back; or close it and open a new range around today's price.</p> : null}

    <dl className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl bg-field p-3">
        <dt className="text-xs text-ink-muted">Holds now</dt>
        <dd className="mt-1 font-medium tabular-nums">{pair(position.amounts)}</dd>
        <dd className="text-sm text-ink-muted">≈ {formatUsd(position.valueUsd)}</dd>
      </div>
      <div className="rounded-xl bg-field p-3">
        <dt className="text-xs text-ink-muted">Fees to collect</dt>
        {position.fees ? <>
          <dd className="mt-1 font-medium tabular-nums">{pair(position.fees)}</dd>
          <dd className="text-sm text-ink-muted">≈ {formatUsd(position.feesUsd)}</dd>
        </> : <dd className="mt-1 text-sm text-ink-muted">{position.venue === 'nadfun-v2'
          ? 'Fees are added to the pair, so your share grows; you receive them when you remove liquidity.'
          : 'Could not read fees right now.'}</dd>}
      </div>
    </dl>

    {automationStatus ? <p role="status" className="mt-4 text-sm text-link">{automationStatus}</p> : null}
    <div className="mt-4 flex flex-wrap gap-2">
      {adapter.collectStep(position) ? <button type="button" className={collectable ? button : secondary}
        disabled={busy || !collectable} onClick={onCollect}>Collect fees</button> : null}
      <button type="button" className={secondary} disabled={busy} onClick={onRemove}>
        {adapter.partialRemove ? 'Remove liquidity' : 'Close position'}</button>
      <button type="button" className={secondary} disabled={busy} onClick={onAddMore}>Add more</button>
      {onAutomation ? <button type="button" className={secondary} onClick={onAutomation}>Automation</button> : null}
    </div>
  </article>
}
