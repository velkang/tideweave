import { useEffect, useState } from 'react'
import { ApiError, type ManagedWalletRecord } from '../../lib/api-client'
import { automationApi, type AutomationRun } from '../../lib/automation-api'
import { useTransactions } from '../../lib/execute'
import { followLink } from '../../lib/route'

/** Wallet-wide lock and live transaction recovery also apply away from Positions. */
export function AutomationStatus({ wallet, onSettled }: { wallet: ManagedWalletRecord | null; onSettled: () => Promise<void> }) {
  const { controller } = useTransactions()
  const [run, setRun] = useState<AutomationRun | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!wallet) { controller.setAutomationBusy(''); setRun(null); setError(''); return }
    let active = true, loading = false, lastRun = '', retryAt = 0
    const refresh = async () => {
      if (!active || loading || Date.now() < retryAt || document.visibilityState !== 'visible') return
      loading = true
      try {
        const result = await automationApi.runs()
        if (!active) return
        const current = result.runs.find(item => item.status === 'running') ?? null
        setRun(current); setError(''); controller.setAutomationBusy(current ? 'Automation running' : '')
        if (current?.state?.pending?.attemptId && !controller.snapshot().polling) void controller.recover()
        if (!current && lastRun) {
          try { await Promise.all([onSettled(), controller.recover()]) }
          catch { setError('Automation finished; wallet balances could not refresh. Open Wallet to retry.') }
          window.dispatchEvent(new Event('automation-settled'))
        }
        lastRun = current?.id ?? ''
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 429) retryAt = Date.now() + reason.retryAfter * 1000
        if (active) { setError(reason instanceof ApiError && reason.status === 429 ? 'Automation checks are temporarily limited. We will retry shortly.' : 'Automation could not be checked. Retry before submitting a transaction.'); controller.setAutomationBusy('Automation check required') }
      } finally { loading = false }
    }
    controller.setAutomationBusy('Checking automation')
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('automation-check', refresh)
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('automation-check', refresh) }
  }, [wallet?.id, controller, onSettled])
  if (!run && !error) return null
  return <p role="status" className="automation-notice">
    {error ? error : `Automation ${run!.kind === 'close' ? 'closing position' : 'rebalancing'} · ${run!.state?.done?.length ?? 0} ${(run!.state?.done?.length ?? 0) === 1 ? 'step' : 'steps'} confirmed`}
    {error ? <button type="button" className="ml-3 min-h-11 text-link underline" onClick={() => window.dispatchEvent(new Event('automation-check'))}>Retry status</button> : null}
    {' '}<a href="/positions" onClick={followLink} className="underline">View positions</a>
  </p>
}
