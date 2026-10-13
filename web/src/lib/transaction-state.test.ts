import { describe, expect, it, vi } from 'vitest'
import { ApiError, type WalletAttempt } from './api-client'
import { TransactionState } from './transaction-state'

const attempt: WalletAttempt = { attemptId: 'a', intentId: 'i', kind: 'swap', transactionHash: '0x123',
  status: 'submitted', failureReason: null }

function setup() {
  let now = 0
  const wait = vi.fn(async (ms: number) => { now += ms })
  const remote = { latestAttempt: vi.fn(async () => ({ attempt })),
    executeIntent: vi.fn(async () => ({ ...attempt, nonce: 1 })),
    reconcileAttempt: vi.fn(async () => ({ ...attempt, status: 'confirmed', reasonCode: 'CONFIRMED' })) }
  const notify = vi.fn()
  const state = new TransactionState(remote, notify, { now: () => now, wait, visible: () => true })
  return { state, remote, notify, wait }
}

describe('shared transaction state', () => {
  it('recovers and confirms a submitted attempt on refresh', async () => {
    const { state, remote } = setup()
    await state.recover()
    expect(remote.reconcileAttempt).toHaveBeenCalledWith('a')
    expect(state.snapshot().attempt?.status).toBe('confirmed')
    expect(state.snapshot().busy).toBe('')
  })

  it('keeps confirmation when refreshing data fails', async () => {
    const { state, notify } = setup()
    const result = await state.run('Swap', async () => ({ intentId: 'i', status: 'pending' }),
      async () => { throw new Error('RPC unavailable') })
    expect(result).toBe('confirmed')
    expect(notify).toHaveBeenCalledWith('success', 'Transaction confirmed', '0x123')
    expect(notify).toHaveBeenCalledWith('info', 'Transaction confirmed; balances could not refresh')
  })

  it('recovers a lost execute response without sending twice', async () => {
    const { state, remote } = setup()
    remote.executeIntent.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0))
    expect(await state.run('Swap', async () => ({ intentId: 'i', status: 'pending' }), async () => {})).toBe('confirmed')
    expect(remote.executeIntent).toHaveBeenCalledTimes(1)
    expect(remote.latestAttempt).toHaveBeenCalledTimes(1)
  })

  it('keeps a throttled attempt pending and prevents another submission', async () => {
    const { state, remote, wait } = setup()
    remote.reconcileAttempt.mockRejectedValue(new ApiError('RATE_LIMITED', 429, undefined, 60))
    await state.recover()
    expect(wait).toHaveBeenCalledWith(60_000)
    expect(state.snapshot()).toMatchObject({ busy: 'Transaction pending', polling: false })
    const prepare = vi.fn()
    expect(await state.run('Swap', prepare, async () => {})).toBe('pending')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('does not reconcile while the page is hidden', async () => {
    const { remote, notify } = setup()
    let now = 0
    const state = new TransactionState(remote, notify, { now: () => now,
      wait: async (ms) => { now += ms }, visible: () => false })
    await state.recover()
    expect(remote.reconcileAttempt).not.toHaveBeenCalled()
    expect(state.snapshot().attempt?.status).toBe('submitted')
  })

  it('ignores work from the previous signed-in user', async () => {
    const { state, remote } = setup()
    let resolve!: (value: { attempt: WalletAttempt }) => void
    remote.latestAttempt.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const recovering = state.recover()
    state.reset()
    resolve({ attempt })
    await recovering
    expect(state.snapshot().attempt).toBeNull()
  })

  it('keeps an uncertain execution locked until the backend can be checked', async () => {
    const { state, remote } = setup()
    remote.executeIntent.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0))
    remote.latestAttempt.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0))
    expect(await state.run('Swap', async () => ({ intentId: 'i', status: 'pending' }), async () => {})).toBe('pending')
    expect(state.snapshot().busy).toBe('Transaction status unavailable')
    await state.recover()
    expect(state.snapshot().attempt?.status).toBe('confirmed')
  })

  it('retains pending status after repeated reconciliation transport failures', async () => {
    const { state, remote } = setup()
    remote.reconcileAttempt.mockRejectedValue(new ApiError('NETWORK_ERROR', 0))
    await state.recover()
    expect(state.snapshot()).toMatchObject({ attempt: { status: 'submitted' }, busy: 'Transaction pending', polling: false })
  })
  it('blocks manual prepares while an automation run owns the wallet and releases on completion', async () => {
    const { state } = setup()
    state.setAutomationBusy('Automation running')
    const prepare = vi.fn(async () => ({ intentId: 'new', status: 'pending' }))
    expect(await state.run('Deposit', prepare, async () => {})).toBe('pending')
    expect(prepare).not.toHaveBeenCalled()
    state.setAutomationBusy('')
    await state.run('Deposit', prepare, async () => {})
    expect(prepare).toHaveBeenCalledOnce()
  })

})
