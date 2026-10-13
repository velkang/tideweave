import { useEffect, useState } from 'react'
import type { Position } from '../../lib/explore-api'
import { automationApi, type AutomationRun, type Band, type Mandate } from '../../lib/automation-api'
import { errorText } from '../../lib/format'
import { button, secondary, input } from '../explore/ui'

type Props = { position: Position; mandate?: Mandate; runs: AutomationRun[]; busy: boolean; onChanged: () => Promise<void> }
export function AutomationPanel({ position, mandate, runs, busy, onChanged }: Props) {
  const [mode, setMode] = useState<'ask' | 'autopilot'>(mandate?.mode ?? 'ask')
  const [band, setBand] = useState<Band | 'agent'>(mandate?.band ?? 'balanced')
  const [limit, setLimit] = useState(String(mandate?.maxPositionUsd ?? Math.ceil(((position.valueUsd ?? 0) + (position.feesUsd ?? 0)) * 1.25) + 1))
  const [daily, setDaily] = useState(String(mandate?.maxRunsPerDay ?? 1))
  const [eligible, setEligible] = useState(false)
  const [eligibilityError, setEligibilityError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const venue = position.venue === 'uniswap-v3' ? 'uniswap-v3' : 'uniswap-v4'
  useEffect(() => {
    let active = true
    automationApi.eligibility(venue, position.pool.id, position.id).then(result => {
      if (active) { setEligible(true); if (!mandate) setLimit(String(Math.ceil(result.valueUsd * 1.25) + 1)) }
    }).catch(reason => { if (active) setEligibilityError(errorText(reason)) })
    return () => { active = false }
  }, [venue, position.pool.id, position.id])
  useEffect(() => {
    if (mandate) { setMode(mandate.mode); setBand(mandate.band); setLimit(String(mandate.maxPositionUsd)); setDaily(String(mandate.maxRunsPerDay)) }
  }, [mandate?.id])
  const perform = async (operation: () => Promise<unknown>) => {
    setSaving(true); setError('')
    try { await operation(); await onChanged() } catch (reason) { setError(errorText(reason)) }
    finally { setSaving(false) }
  }
  const save = (status: 'active' | 'paused') => automationApi.save({ venue, pairId: position.pool.id, tokenId: position.id,
    mode, band, maxPositionUsd: Number(limit), maxRunsPerDay: Number(daily), status })
  return <div className="space-y-5">
    <p className="text-sm text-ink-muted">Rebalancing closes this position, swaps its returned tokens as needed, and opens a new range. Extra proceeds stay in your managed wallet.</p>
    {!eligible ? <p role="status" className="text-sm text-ink-muted">{eligibilityError ? `Automation unavailable: ${eligibilityError}` : 'Checking automation eligibility…'}</p> : null}
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void perform(() => save('active')) }}>
      <label className="block text-sm">Decision mode<select className={`${input} mt-1 w-full`} value={mode}
        onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="ask">Ask me before acting</option><option value="autopilot">Autopilot</option>
      </select></label>
      {mode === 'autopilot' ? <p className="text-sm text-rest">Saving enables automatic transactions within these limits, without asking you to approve each run.</p>
        : <p className="text-sm text-ink-muted">Suggestions require your approval before any transaction is submitted.</p>}
      <label className="block text-sm">New range<select className={`${input} mt-1 w-full`} value={band}
        onChange={event => setBand(event.target.value as typeof band)}>
        <option value="wide">Wide ±25%</option><option value="balanced">Balanced ±10%</option><option value="narrow">Narrow ±3%</option>
        <option value="agent">Let the agent choose</option></select></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">Maximum position USD<input className={`${input} mt-1 w-full`} type="number" min="1" max="1000000" step="1" required value={limit} onChange={event => setLimit(event.target.value)} /></label>
        <label className="text-sm">Runs per 24 hours<input className={`${input} mt-1 w-full`} type="number" min="1" max="24" step="1" required value={daily} onChange={event => setDaily(event.target.value)} /></label>
      </div>
      <p className="text-xs text-ink-muted">Automation requires a stablecoin or MON/WMON anchor and a fresh valuation from a sufficiently liquid pool. Unknown valuations leave the position unchanged.</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={saving || busy || !eligible}>Save automation</button>
        <button type="button" className={secondary} disabled={saving || busy || !eligible || band === 'agent'}
          onClick={() => void perform(() => automationApi.rebalance(venue, position.pool.id, position.id, band as Band))}>Rebalance now</button>
        {mandate ? <>
          <button type="button" className={secondary} disabled={saving} onClick={() => void perform(() => automationApi.save({ venue: mandate.venue, pairId: mandate.poolId, tokenId: mandate.tokenId, mode: mandate.mode, band: mandate.band, maxPositionUsd: mandate.maxPositionUsd, maxRunsPerDay: mandate.maxRunsPerDay, status: mandate.status === 'active' ? 'paused' : 'active' }))}>{mandate.status === 'active' ? 'Pause' : 'Resume'}</button>
          <button type="button" className={secondary} disabled={saving} onClick={() => void perform(() => automationApi.revoke(mandate.id))}>Revoke</button>
        </> : null}
      </div>
    </form>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <div aria-live="polite" className="space-y-3">
      {mandate ? <p className="text-sm">Automation is {mandate.status} · {mandate.mode === 'ask' ? 'Ask first' : 'Autopilot'}</p> : null}
      {runs.map(run => <div key={run.id} className="border-t border-line pt-3 text-sm">
        <p className="font-medium">{run.kind === 'close' ? 'Close position' : 'Rebalance'} · {run.status}</p>
        {run.reason ? <p className="mt-1 text-ink-muted">{run.reason}</p> : null}
        {run.state?.done?.length ? <p className="mt-1 text-ink-muted">Confirmed: {run.state.done.join(', ')}</p> : null}
        {run.state?.pending?.transactionHash ? <a className="mt-2 inline-block text-link underline" href={`https://monadscan.com/tx/${run.state.pending.transactionHash}`} target="_blank" rel="noreferrer">View pending transaction</a> : null}
        {run.status === 'failed' ? <p role="status" className="mt-1 text-danger">{run.failureReason?.replaceAll('_', ' ').toLowerCase()}. {run.state?.done?.includes('close') ? 'The position was closed. Returned assets remain in your managed wallet unless a later confirmed step used them.' : 'Review the transaction status before trying again.'}</p> : null}
        {run.status === 'proposed' ? <div className="mt-2 flex gap-2">
          <button className={button} disabled={saving || busy || !eligible} onClick={() => void perform(() => automationApi.approve(run.id))}>Approve</button>
          <button className={secondary} disabled={saving} onClick={() => void perform(() => automationApi.decline(run.id))}>Decline</button>
        </div> : null}
      </div>)}
    </div>
  </div>
}
