import { describe, expect, it } from 'vitest'
import { ApiError } from './api-client'
import { retryWhileCatchingUp } from './deposit-flow'

const noWait = async () => undefined

describe('preparing right after an approval or swap', () => {
  it('retries while the API still reads the block before the approval', async () => {
    let calls = 0
    const result = await retryWhileCatchingUp(async () => {
      calls += 1
      if (calls < 3) throw new ApiError('TOKEN_APPROVAL_REQUIRED', 422)
      return 'prepared'
    }, { wait: noWait })
    expect(result).toBe('prepared')
    expect(calls).toBe(3)
  })

  it('gives up after the last attempt', async () => {
    let calls = 0
    await expect(retryWhileCatchingUp(async () => { calls += 1; throw new ApiError('PERMIT2_APPROVAL_REQUIRED', 422) },
      { attempts: 4, wait: noWait })).rejects.toThrow('PERMIT2_APPROVAL_REQUIRED')
    expect(calls).toBe(4)
  })

  it('does not retry other errors', async () => {
    let calls = 0
    await expect(retryWhileCatchingUp(async () => { calls += 1; throw new ApiError('MINT_SIMULATION_FAILED', 422) },
      { wait: noWait })).rejects.toThrow('MINT_SIMULATION_FAILED')
    expect(calls).toBe(1)
  })
})
