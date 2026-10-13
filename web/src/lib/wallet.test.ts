import { describe, expect, it } from 'vitest'
import type { WalletBalances } from './explore-api'
import { SWAP_GAS_BUFFER, WITHDRAW_GAS_BUFFER, swapSpendable, withdrawable } from './wallet'

const ONE = 10n ** 18n
const USDC = { address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', symbol: 'USDC', decimals: 6, balance: '2500000', usd: 2.5 }
const balances = (mon: bigint, reserve = 0n): WalletBalances => ({ address: '0x90e242E0ABc00Eb8bceBe3Eb91a9B0AE7e7799ef',
  delegate: reserve > 0n ? '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9' : null, reserve: reserve.toString(),
  mon: { balance: mon.toString(), usd: null }, tokens: [USDC], totalUsd: 0, unpricedAssetCount: 0 })

describe('what can be withdrawn', () => {
  it('is the whole balance of a token', () => {
    expect(withdrawable(balances(ONE), USDC.address)).toBe(2_500_000n)
    expect(withdrawable(balances(ONE), '0x1111111111111111111111111111111111111111')).toBe(0n)
  })

  it('keeps MON for the fee, and the 10 MON reserve on a delegated wallet', () => {
    expect(withdrawable(balances(5n * ONE), '0x0000000000000000000000000000000000000000')).toBe(5n * ONE - WITHDRAW_GAS_BUFFER)
    expect(withdrawable(balances(12n * ONE, 10n * ONE), '0x0000000000000000000000000000000000000000'))
      .toBe(2n * ONE - WITHDRAW_GAS_BUFFER)
    expect(withdrawable(balances(9n * ONE, 10n * ONE), '0x0000000000000000000000000000000000000000')).toBe(0n)
  })
})

describe('what a swap can sell', () => {
  const pairAssets = (token0Address: string, balance0: bigint, mon: bigint, delegate: string | null = null) => ({
    venue: 'uniswap-v4' as const, id: `0x${'5f'.repeat(32)}`, walletAddress: '0x90e242E0ABc00Eb8bceBe3Eb91a9B0AE7e7799ef',
    token0: { address: token0Address, symbol: 'T0', decimals: 18, balance: balance0.toString() },
    token1: { address: USDC.address, symbol: 'USDC', decimals: 6, balance: '2500000' },
    monBalance: mon.toString(), delegate, approvals: [] })

  it('is the whole balance of a token', () => {
    expect(swapSpendable(pairAssets('0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', 7n * ONE, ONE), 0)).toBe(7n * ONE)
    expect(swapSpendable(pairAssets('0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', 7n * ONE, ONE), 1)).toBe(2_500_000n)
  })

  it('keeps MON for gas when selling MON, and the 10 MON reserve on a delegated wallet', () => {
    const native = '0x0000000000000000000000000000000000000000'
    expect(swapSpendable(pairAssets(native, 5n * ONE, 5n * ONE), 0)).toBe(5n * ONE - SWAP_GAS_BUFFER)
    expect(swapSpendable(pairAssets(native, 12n * ONE, 12n * ONE, '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9'), 0))
      .toBe(2n * ONE - SWAP_GAS_BUFFER)
    expect(swapSpendable(pairAssets(native, 10n ** 16n, 10n ** 16n), 0)).toBe(0n)
  })
})
