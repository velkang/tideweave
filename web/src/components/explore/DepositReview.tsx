import { useEffect, useRef } from 'react'
import { formatAmount, formatFee } from '../../lib/format'
import type { PairDetail } from '../../lib/explore-api'
import { StepList } from './StepList'
import { button, secondary } from './ui'

type Props = {
  pair: PairDetail
  amounts: [bigint, bigint]
  /** MON the nad.fun deposit wraps into WMON first. */
  wrapAmount: bigint
  /** "while 1 WMON is between …", or null for nad.fun, which has no range. */
  range: string | null
  slippage: string
  notes: string[]
  /** Every transaction this deposit needs, in order. */
  steps: string[]
  /** How many steps have confirmed. */
  done: number
  running: boolean
  disabled: boolean
  onConfirm: () => void
  onEdit: () => void
}

/** What the deposit adds and the transactions it takes; Confirm runs them all in order. */
export function DepositReview(props: Props) {
  const { pair, amounts, wrapAmount, range, slippage, notes, steps, done, running, onConfirm, onEdit } = props
  const ref = useRef<HTMLElement>(null)
  // The review opens below the form; bring it into view once.
  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [])
  const rows = [
    { label: 'You add', value: `${formatAmount(amounts[0], pair.token0.decimals)} ${pair.token0.symbol} + ${formatAmount(amounts[1], pair.token1.decimals)} ${pair.token1.symbol}` },
    ...(wrapAmount > 0n ? [{ label: 'MON used', value: `${formatAmount(wrapAmount, 18)}` }] : []),
    { label: 'Earns', value: range ?? 'at any price' },
    { label: 'Fee per trade', value: formatFee(pair.fee) },
    { label: 'Max price change', value: `${slippage}%` },
  ]
  return <section ref={ref} aria-labelledby="review-heading" className="rounded-2xl border border-line bg-field p-4 sm:p-5">
    <h4 id="review-heading" className="text-lg font-semibold">Review your deposit</h4>
    <dl className="mt-3">{rows.map((row) => <div key={row.label}
      className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-line py-2.5 text-sm">
      <dt className="text-ink-muted">{row.label}</dt><dd className="min-w-0 text-right font-medium tabular-nums">{row.value}</dd>
    </div>)}</dl>
    {notes.map((note) => <p key={note} className="mt-2 text-sm text-ink-muted">{note}</p>)}

    <h5 className="mt-4 text-sm font-semibold">{steps.length === 1 ? 'One transaction' : `${steps.length} transactions, in order`}</h5>
    <div className="mt-2"><StepList steps={steps} done={done} running={running} /></div>

    <div className="mt-5 flex flex-wrap gap-3">
      <button type="button" className={button} disabled={running || props.disabled} onClick={onConfirm}>
        {running ? 'Adding liquidity…' : done > 0 ? 'Continue' : 'Confirm and add liquidity'}</button>
      <button type="button" className={secondary} disabled={running || props.disabled} onClick={onEdit}>Edit</button>
    </div>
  </section>
}
