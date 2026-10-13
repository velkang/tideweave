import { ApiError, type api, type WalletAttempt } from './api-client'
import type { Prepared } from './explore-api'
import { errorText } from './format'
import type { DepositPlan } from './deposit-flow'

export type Notify = (type: 'success' | 'error' | 'info', title: string, message?: string) => void
export type RunResult = 'confirmed' | 'pending' | 'failed'
type Remote = Pick<typeof api, 'latestAttempt' | 'executeIntent' | 'reconcileAttempt'>
type Snapshot = { attempt: WalletAttempt | null; busy: string; polling: boolean; automationBusy?: string }
const pending = (attempt: WalletAttempt | null) => attempt?.status === 'submitted'

/** One wallet's submission state; the backend remains authoritative after a reload. */
export class TransactionState {
  readonly depositPlans = new Map<string, DepositPlan>()
  executingIntentId = ''
  private value: Snapshot = { attempt: null, busy: '', polling: false }
  private listeners = new Set<() => void>()
  private generation = 0
  private checking: Promise<RunResult> | null = null
  constructor(private remote: Remote, private notify: Notify,
    private clock = { now: Date.now, wait: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
      visible: () => document.visibilityState === 'visible' }) {}

  snapshot = () => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(value: Partial<Snapshot>) { this.value = { ...this.value, ...value }; this.listeners.forEach((fn) => fn()) }
  setAutomationBusy(automationBusy: string) { this.update({ automationBusy }) }
  reset() {
    this.generation++; this.checking = null; this.executingIntentId = ''; this.depositPlans.clear()
    this.update({ attempt: null, busy: '', polling: false, automationBusy: '' })
  }

  async recover(): Promise<void> {
    const generation = this.generation
    this.update({ busy: 'Checking transaction' })
    try {
      const { attempt } = await this.remote.latestAttempt()
      if (generation !== this.generation) return
      this.update({ attempt, busy: pending(attempt) ? 'Transaction pending' : '' })
      if (pending(attempt)) await this.check()
    } catch (error) {
      if (generation === this.generation) {
        this.update({ busy: 'Transaction status unavailable' })
        this.notify('info', 'Transaction status unavailable', errorText(error))
      }
    }
  }

  check = (): Promise<RunResult> => {
    if (this.checking) return this.checking
    if (!this.value.attempt) return this.recover().then(() => 'pending')
    const generation = this.generation
    const checking = this.poll(generation).finally(() => {
      if (generation === this.generation) { this.checking = null; this.update({ polling: false }) }
    })
    this.checking = checking
    return checking
  }

  private async poll(generation: number): Promise<RunResult> {
    const start = this.clock.now()
    this.update({ polling: true })
    while (this.clock.now() - start < 90_000 && generation === this.generation) {
      const attempt = this.value.attempt
      if (!attempt) return 'pending'
      if (!pending(attempt)) return attempt.status === 'confirmed' ? 'confirmed' : 'failed'
      if (!this.clock.visible()) { await this.clock.wait(3000); continue }
      let pause = 3000
      try {
        const result = await this.remote.reconcileAttempt(attempt.attemptId)
        if (generation !== this.generation) return 'pending'
        this.update({ attempt: { ...attempt, status: result.status, failureReason: result.reasonCode } })
        if (result.status === 'confirmed') {
          this.update({ busy: '' })
          this.notify('success', 'Transaction confirmed', attempt.transactionHash)
          return 'confirmed'
        }
        if (['failed', 'quarantined', 'replaced'].includes(result.status)) {
          this.update({ busy: '' }); this.notify('error', 'Transaction failed', errorText(new Error(result.reasonCode)))
          return 'failed'
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) pause = error.retryAfter * 1000
      }
      await this.clock.wait(pause)
    }
    return 'pending'
  }

  async run(label: string, prepare: () => Promise<Prepared>, settled: () => Promise<void>): Promise<RunResult> {
    if (this.value.busy || this.value.automationBusy) return 'pending'
    const generation = this.generation
    this.update({ busy: label })
    let executing = false
    let intentId = ''
    try {
      intentId = (await prepare()).intentId
      if (generation !== this.generation) return 'pending'
      this.executingIntentId = intentId
      executing = true
      const submission = await this.remote.executeIntent(intentId)
      if (generation !== this.generation) return 'pending'
      this.update({ attempt: { ...submission, kind: label, status: 'submitted', failureReason: null }, busy: 'Transaction pending' })
    } catch (error) {
      if (generation !== this.generation) return 'pending'
      if (executing) {
        try {
          const { attempt } = await this.remote.latestAttempt()
          if (generation !== this.generation) return 'pending'
          if (attempt?.intentId === intentId) this.update({ attempt, busy: pending(attempt) ? 'Transaction pending' : '' })
          else throw error
        } catch (lookupError) {
          if (generation !== this.generation) return 'pending'
          // Without a reliable status read, another submission must wait for a manual check.
          if (lookupError !== error) { this.update({ busy: 'Transaction status unavailable' }); return 'pending' }
          this.update({ busy: '' }); this.notify('error', `${label} failed`, errorText(error))
          return 'failed'
        }
      } else {
        this.update({ busy: '' }); this.notify('error', `${label} failed`, errorText(error))
        return 'failed'
      }
    }
    const confirmedFromLookup = this.value.attempt?.status === 'confirmed'
    const result = await this.check()
    if (result === 'confirmed') {
      if (confirmedFromLookup) this.notify('success', 'Transaction confirmed', this.value.attempt!.transactionHash)
      try { await settled() }
      catch { this.notify('info', 'Transaction confirmed; balances could not refresh') }
    }
    return result
  }
}
