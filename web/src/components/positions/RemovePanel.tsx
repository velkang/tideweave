import { useState } from 'react'
import type { Position } from '../../lib/explore-api'
import { formatToken } from '../../lib/format'
import { hasFees } from '../../lib/positions'
import { VENUES } from '../../lib/venues'
import { button } from '../explore/ui'

type Props = {
  position: Position
  busy: boolean
  /** Index of the step running, or null when idle. */
  running: number | null
  onConfirm: (percent: number) => void
}

const PERCENTS = [25, 50, 75, 100]

/** Chooses how much of a position to return to the wallet, shows what comes back, and runs it. */
export function RemovePanel({ position, busy, running, onConfirm }: Props) {
  const adapter = VENUES[position.venue]
  const [percent, setPercent] = useState(100)
  const chosen = adapter.partialRemove ? percent : 100
  const steps = adapter.removeSteps(position, chosen)
  const { pool } = position
  const part = (raw: string) => BigInt(raw) * BigInt(chosen) / 100n
  // Removing any share collects every earned fee too: v3 follows its decrease with a collect, and a v4
  // decrease settles the position's fees as it takes the tokens.
  const withFees = hasFees(position)

  return <div className="flex flex-col gap-5">
    {adapter.partialRemove ? <div role="radiogroup" aria-label="How much to remove" className="grid grid-cols-4 gap-2">
      {PERCENTS.map((value) => <button key={value} type="button" role="radio" aria-checked={percent === value}
        disabled={running !== null} onClick={() => setPercent(value)}
        className={`min-h-11 rounded-full border text-sm font-semibold ${percent === value ? 'border-link bg-tint text-link' : 'border-line hover:bg-tint'}`}>
        {value === 100 ? 'All' : `${value}%`}</button>)}
    </div> : null}

    <dl className="rounded-xl border border-line bg-field p-4 text-sm">
      <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-ink-muted">You receive about</dt>
        <dd className="text-right font-medium tabular-nums">{formatToken(part(position.amounts.amount0), pool.token0.decimals)} {pool.token0.symbol} + {formatToken(part(position.amounts.amount1), pool.token1.decimals)} {pool.token1.symbol}</dd></div>
      {withFees && position.fees ? <div className="mt-2 flex flex-wrap justify-between gap-x-4"><dt className="text-ink-muted">Plus fees</dt>
        <dd className="text-right font-medium tabular-nums">{formatToken(position.fees.amount0, pool.token0.decimals)} {pool.token0.symbol} + {formatToken(position.fees.amount1, pool.token1.decimals)} {pool.token1.symbol}</dd></div> : null}
      <div className="mt-2 flex flex-wrap justify-between gap-x-4"><dt className="text-ink-muted">Goes to</dt>
        <dd className="text-right">Your managed wallet</dd></div>
    </dl>
    <p className="text-xs text-ink-muted">If the price moves more than 1% before it confirms, nothing is removed.</p>

    <ol className="flex flex-col gap-2">{steps.map((step, index) => {
      const state = running === null ? 'todo' : index < running ? 'done' : index === running ? 'now' : 'todo'
      return <li key={step.label} className="flex items-center gap-3 text-sm">
        <span aria-hidden="true" className={`inline-grid size-7 place-items-center rounded-full border text-xs font-semibold ${state === 'done' ? 'border-link bg-link text-on-accent' : state === 'now' ? 'border-link text-link' : 'border-line text-ink-muted'}`}>
          {state === 'done' ? '✓' : state === 'now' ? '…' : index + 1}</span>
        <span>{step.label}<span className="sr-only">: {state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'to do'}</span></span>
      </li>
    })}</ol>

    <button type="button" className={button} disabled={busy || running !== null} onClick={() => onConfirm(chosen)}>
      {running !== null ? 'Working…' : chosen === 100 ? 'Close position' : `Remove ${chosen}%`}</button>
  </div>
}
