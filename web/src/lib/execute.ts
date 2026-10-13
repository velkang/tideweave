import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import type { Prepared } from './explore-api'
import { TransactionState, type Notify, type RunResult } from './transaction-state'

export type { Notify, RunResult } from './transaction-state'
export type RunIntent = (label: string, prepare: () => Promise<Prepared>) => Promise<RunResult>
export const TransactionContext = createContext<TransactionState | null>(null)

export function useTransactions() {
  const controller = useContext(TransactionContext)
  if (!controller) throw new Error('TransactionContext is required')
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return { controller, ...state, busy: state.busy || state.automationBusy || '' }
}

/** Every screen shares one submission lock and the backend's recovered attempt. */
export function useIntentRunner(onNotify: Notify, onSettled: () => Promise<void>) {
  const { controller, busy, attempt } = useTransactions()
  const settled = useRef(onSettled)
  settled.current = onSettled
  const refreshed = useRef('')
  const refresh = useCallback(async () => {
    const current = controller.snapshot().attempt
    if (current?.status !== 'confirmed' || refreshed.current === current.attemptId) return
    refreshed.current = current.attemptId
    await settled.current()
  }, [controller])
  useEffect(() => {
    if (attempt?.status === 'confirmed') void refresh().catch(() =>
      onNotify('info', 'Transaction confirmed; balances could not refresh'))
  }, [attempt?.status, attempt?.attemptId, refresh, onNotify])
  const run = useCallback((label: string, prepare: () => Promise<Prepared>) =>
    controller.run(label, prepare, refresh), [controller, refresh])
  return { busy, run }
}
