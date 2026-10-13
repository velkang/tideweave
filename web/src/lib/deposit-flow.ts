import { ApiError } from './api-client'
import type { Step } from './venues'
import type { Ticks } from './deposit-math'

/** A reviewed deposit remains in memory for this signed-in session, never across a reload. */
export type DepositPlan = { steps: Step[]; done: number; amounts: [bigint, bigint]; wrapAmount: bigint;
  ticks: Ticks | null; slippage: string; inverted: boolean; pendingIntentId?: string }

// The API prepares against Monad's "safe" block, which can trail a transaction that has just
// confirmed. A deposit prepared straight after its approval, or after a swap, may not see it yet.
const CATCHING_UP = new Set(['TOKEN_APPROVAL_REQUIRED', 'ERC20_APPROVAL_REQUIRED', 'PERMIT2_APPROVAL_REQUIRED',
  'SWAP_APPROVAL_REQUIRED', 'INSUFFICIENT_TOKEN_BALANCE'])

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Runs `prepare`, retrying a few times while the safe block catches up with a just-confirmed step. */
export async function retryWhileCatchingUp<T>(prepare: () => Promise<T>,
  { attempts = 5, wait = () => pause(1500) }: { attempts?: number; wait?: () => Promise<void> } = {}): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await prepare() }
    catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      if (!CATCHING_UP.has(code) || attempt >= attempts) throw error
      await wait()
    }
  }
}
