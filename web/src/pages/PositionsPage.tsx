import { Loader } from '../components/Loader'
import { AutomationPanel } from '../components/positions/AutomationPanel'
import { automationApi, type Mandate, type AutomationRun } from '../lib/automation-api'
import { ApiError } from '../lib/api-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { ManagedWalletRecord } from '../lib/api-client'
import { exploreApi, type Position, type Venue } from '../lib/explore-api'
import { useIntentRunner, type Notify, type RunResult } from '../lib/execute'
import { errorText } from '../lib/format'
import { formatUsd, hasFees, positionTotals } from '../lib/positions'
import { followLink } from '../lib/route'
import { VENUES, type Step } from '../lib/venues'
import { Sheet } from '../components/explore/Sheet'
import { button, card, secondary } from '../components/explore/ui'
import { PositionCard } from '../components/positions/PositionCard'
import { RemovePanel } from '../components/positions/RemovePanel'

type Props = {
  wallet: ManagedWalletRecord | null
  signedIn: boolean
  onSignIn: () => void
  onOpenWallet: () => void
  onOpenPair: (venue: Venue, id: string) => void
  onRefreshWallet: () => Promise<void>
  onNotify: Notify
}

const key = (position: Position) => `${position.venue}:${position.id}`

/** Every position the managed wallet holds, on every venue: what each holds and earns, and its actions. */
export function PositionsPage({ wallet, signedIn, onSignIn, onOpenWallet, onOpenPair, onRefreshWallet, onNotify }: Props) {
  const identity = useRef(wallet?.id); identity.current = wallet?.id
  const [automationPosition, setAutomationPosition] = useState<Position | null>(null)
  const [mandates, setMandates] = useState<Mandate[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [automationError, setAutomationError] = useState('')
  const [positions, setPositions] = useState<Position[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<Position | null>(null)
  const [runningStep, setRunningStep] = useState<number | null>(null)

  const load = useCallback(async (upTo = 0, rethrow = false) => {
    if (!wallet) return
    const id = wallet.id
    setLoading(true)
    try {
      const pages = await Promise.all(Array.from({ length: upTo + 1 }, (_, index) => exploreApi.listPositions(index)))
      if (identity.current !== id) return
      setPositions(pages.flatMap((result) => result.positions))
      setHasMore(pages[pages.length - 1].hasMore)
      setPage(upTo)
      setError('')
    } catch (reason) { if (identity.current === id) setError(errorText(reason)); if (rethrow) throw reason }
    finally { if (identity.current === id) setLoading(false) }
  }, [wallet])

  const settled = useCallback(async () => { await Promise.all([load(page, true), onRefreshWallet()]) }, [load, page, onRefreshWallet])
  const { busy, run } = useIntentRunner(onNotify, settled)

  useEffect(() => { if (wallet) void load(0); else setPositions([]) }, [wallet?.address]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadAutomation = useCallback(async () => {
    if (!wallet) return
    const id = wallet.id
    const [saved, recent] = await Promise.all([automationApi.mandates(), automationApi.runs()])
    if (identity.current !== id) return
    setMandates(saved.mandates); setRuns(recent.runs); setAutomationError('')
  }, [wallet?.id])
  useEffect(() => {
    setMandates([]); setRuns([]); setAutomationError(''); setAutomationPosition(null)
    if (!wallet) return
    let active = true, checking = false, retryAt = 0
    const refresh = async () => {
      if (!active || checking || Date.now() < retryAt || document.visibilityState !== 'visible') return
      checking = true
      try { await loadAutomation() }
      catch (reason) {
        if (reason instanceof ApiError && reason.status === 429) retryAt = Date.now() + reason.retryAfter * 1000
        if (active) setAutomationError(errorText(reason))
      } finally { checking = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [wallet?.id, loadAutomation])

  /** Runs steps in order, stopping at the first that does not confirm. */
  const runSteps = async (steps: Step[], onStep?: (index: number) => void): Promise<RunResult> => {
    for (const [index, step] of steps.entries()) {
      onStep?.(index)
      const result = await run(step.label, step.prepare)
      if (result !== 'confirmed') return result
    }
    return 'confirmed'
  }

  useEffect(() => {
    const refresh = () => { void load(0); void loadAutomation().catch(reason => setAutomationError(errorText(reason))) }
    window.addEventListener('automation-settled', refresh)
    return () => window.removeEventListener('automation-settled', refresh)
  }, [load, loadAutomation])

  const collect = async (position: Position) => {
    const step = VENUES[position.venue].collectStep(position)
    if (step && await runSteps([step]) === 'confirmed') onNotify('success', 'Fees collected', 'They are in your managed wallet.')
  }

  const collectable = positions.filter((position) => hasFees(position) && VENUES[position.venue].collectStep(position))
  const collectAll = async () => {
    const steps = collectable.flatMap((position) => {
      const step = VENUES[position.venue].collectStep(position)
      return step ? [{ ...step, label: `Collect ${position.pool.token0.symbol} / ${position.pool.token1.symbol} fees` }] : []
    })
    if (await runSteps(steps) === 'confirmed') onNotify('success', 'All fees collected', 'They are in your managed wallet.')
  }

  const remove = async (percent: number) => {
    if (!removing) return
    try {
      const result = await runSteps(VENUES[removing.venue].removeSteps(removing, percent), setRunningStep)
      if (result === 'confirmed') {
        onNotify('success', percent >= 100 ? 'Position closed' : `Removed ${percent}%`, 'The tokens are in your managed wallet; open Wallet to withdraw them.')
        setRemoving(null)
      }
    } finally { setRunningStep(null) }
  }

  const orphanRuns = runs.filter(r => !positions.some(p => p.venue === r.venue && p.id === r.tokenId && p.pool.id.toLowerCase() === r.poolId.toLowerCase()))
  const orphanMandates = mandates.filter(m => !positions.some(p => p.venue === m.venue && p.id === m.tokenId && p.pool.id.toLowerCase() === m.poolId.toLowerCase()))
  const revoke = async (id: string) => {
    try { await automationApi.revoke(id); await loadAutomation(); window.dispatchEvent(new Event('automation-check')) }
    catch (reason) { setAutomationError(errorText(reason)) }
  }
  const automationStatus = (position: Position) => {
    const matches = (item: { venue: string; tokenId: string; poolId: string }) => item.venue === position.venue && item.tokenId === position.id && item.poolId.toLowerCase() === position.pool.id.toLowerCase()
    const recent = runs.find(r => matches(r) && (r.status === 'running' || r.status === 'proposed'))
    if (recent) return recent.status === 'running' ? 'Position automation running' : 'Rebalance proposal awaiting your review'
    const mandate = mandates.find(matches)
    return mandate ? `Automation ${mandate.status} · ${mandate.mode === 'ask' ? 'Ask first' : 'Autopilot'}` : undefined
  }
  const totals = positionTotals(positions)
  if (!wallet) {
    return <Empty title="Your positions" text={signedIn ? 'Create your managed wallet to add liquidity.' : 'Sign in to see your positions.'}
      action={signedIn ? <button className={button} onClick={onOpenWallet}>Create wallet</button>
        : <button type="button" className={button} onClick={onSignIn}>Sign in</button>} />
  }

  return <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 text-ink">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-4xl font-semibold">Your positions</h1></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondary} onClick={onOpenWallet}>Wallet</button>
        <button type="button" className={secondary} disabled={loading} onClick={() => void load(page)}>
          {loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
    </div>

    {positions.length > 0 ? <section className={`${card} grid gap-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-center`} aria-label="Summary">
      <Stat label="Worth now" value={formatUsd(totals.valueUsd)} note={totals.unpriced ? `${totals.unpriced} not priced` : undefined} />
      <Stat label="Fees to collect" value={formatUsd(totals.feesUsd)} />
      <Stat label="Earning" value={`${totals.earning} of ${totals.count}`} />
      <button type="button" className={button} disabled={Boolean(busy) || collectable.length === 0}
        onClick={() => void collectAll()}>{collectable.length > 1 ? `Collect all fees (${collectable.length})` : 'Collect all fees'}</button>
    </section> : null}

    {automationError ? <p role="status" className="text-sm text-ink-muted">Position automation could not refresh: {automationError}</p> : null}
    {error ? <p role="alert" className="rounded-xl border border-danger-line bg-danger-soft p-3 text-sm">{error}</p> : null}
    {loading && positions.length === 0 ? <Loader label="Loading positions" /> : null}
    {!loading && !error && positions.length === 0
      ? <Empty title="" text="No positions yet. Pick a pair on Explore and add liquidity; it shows up here."
        action={<a className={button} href="/explore" onClick={followLink}>Explore pairs</a>} /> : null}

    <div className="grid gap-4">{positions.map((position) => <PositionCard key={key(position)} position={position}
      automationStatus={automationStatus(position)} busy={Boolean(busy)} onCollect={() => void collect(position)} onRemove={() => setRemoving(position)}
      onAddMore={() => onOpenPair(position.venue, position.pool.id)} onAutomation={position.venue !== 'nadfun-v2' ? () => setAutomationPosition(position) : undefined} />)}</div>
    {orphanRuns.length || orphanMandates.length ? <section aria-labelledby="closed-automation-heading" className="border-t border-line pt-6">
      <h2 id="closed-automation-heading" className="text-xl font-semibold">Automation for closed or unloaded positions</h2>
      {orphanRuns.map(item => <div key={item.id} className="mt-4 border-b border-line pb-4 text-sm">
        <p className="font-medium">NFT #{item.tokenId} · {item.venue} · {item.kind === 'close' ? 'Close' : 'Rebalance'} · {item.status}</p>
        {item.reason ? <p className="mt-1 text-ink-muted">{item.reason}</p> : null}
        {item.state?.done?.length ? <p className="mt-1 text-ink-muted">Confirmed: {item.state.done.join(', ')}</p> : null}
        {item.state?.pending?.transactionHash ? <a className="mt-2 inline-block text-link underline" href={`https://monadscan.com/tx/${item.state.pending.transactionHash}`} target="_blank" rel="noreferrer">View pending transaction</a> : null}
        {item.status === 'failed' ? <p className="mt-1 text-danger">{item.failureReason?.replaceAll('_', ' ').toLowerCase() || 'Run interrupted'}. {item.state?.done?.includes('close') ? 'Returned assets remain in your wallet except amounts used by later confirmed steps.' : 'Review transaction status before trying again.'}</p> : null}
      </div>)}
      {orphanMandates.map(item => <div key={item.id} className="mt-3 flex flex-wrap items-center gap-3 text-sm"><span>Mandate for NFT #{item.tokenId} · {item.status}</span><button className={secondary} onClick={() => void revoke(item.id)}>Revoke</button></div>)}
    </section> : null}
    {hasMore ? <button type="button" className={`${secondary} self-start`} disabled={loading}
      onClick={() => void load(page + 1)}>Show more positions</button> : null}

    {busy ? <p role="status" className="text-sm text-link">{busy}…</p> : null}

    <AnimatePresence>
      {automationPosition ? <Sheet key="automation" title="Position automation"
        description={`${automationPosition.pool.token0.symbol} / ${automationPosition.pool.token1.symbol} · NFT #${automationPosition.id}`}
        onClose={() => setAutomationPosition(null)}>
        <AutomationPanel key={`${wallet.id}:${automationPosition.venue}:${automationPosition.id}`} position={automationPosition}
          mandate={mandates.find(m => m.venue === automationPosition.venue && m.tokenId === automationPosition.id && m.poolId.toLowerCase() === automationPosition.pool.id.toLowerCase())}
          runs={runs.filter(r => r.venue === automationPosition.venue && r.tokenId === automationPosition.id && r.poolId.toLowerCase() === automationPosition.pool.id.toLowerCase())}
          busy={Boolean(busy)} onChanged={async () => { window.dispatchEvent(new Event('automation-check')); await loadAutomation() }} />
      </Sheet> : null}
      {removing ? <Sheet key="remove" title={VENUES[removing.venue].partialRemove ? 'Remove liquidity' : 'Close position'}
        description={`${removing.pool.token0.symbol} / ${removing.pool.token1.symbol}: the tokens return to your managed wallet, where you can add them elsewhere or withdraw them.`}
        onClose={() => { if (runningStep === null) setRemoving(null) }}>
        <RemovePanel position={removing} busy={Boolean(busy)} running={runningStep} onConfirm={(percent) => void remove(percent)} />
      </Sheet> : null}
    </AnimatePresence>
  </div>
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div><p className="text-xs text-ink-muted">{label}</p><p className="text-2xl font-semibold tabular-nums">{value}</p>
    {note ? <p className="text-xs text-ink-muted">{note}</p> : null}</div>
}

function Empty({ title, text, action }: { title: string; text: string; action: React.ReactNode }) {
  return <section className="mx-auto flex w-full max-w-[1100px] flex-col items-start gap-4">
    {title ? <h1 className="text-4xl font-semibold">{title}</h1> : null}
    <p className="max-w-[560px] text-lg text-ink-muted">{text}</p>
    {action}
  </section>
}
