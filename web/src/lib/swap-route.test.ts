import { describe, expect, it } from 'vitest'
import type { PairListItem, WalletBalances } from './explore-api'
import { MON, sellable, tokensIn, tradedWith, withPairAssets } from './swap-route'

const BLOBY = { address: '0x1111111111111111111111111111111111111111', symbol: 'BLOBY', decimals: 18 }
const XNVDA = { address: '0x2222222222222222222222222222222222222222', symbol: 'xNVDA', decimals: 18 }
const WMON = { address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', symbol: 'WMON', decimals: 18 }
const ONE = 10n ** 18n

const pool = (id: string, token0: typeof MON, token1: typeof MON, venue: PairListItem['venue'] = 'uniswap-v4'): PairListItem =>
  ({ venue, id, token0, token1, fee: 3000, tickSpacing: 60, hooks: null, sqrtPriceX96: null, tick: 0, liquidity: '1',
    reserve0: null, reserve1: null, memeToken: null, createdBlock: null })
const pairs = [
  pool('0xa1', BLOBY, XNVDA, 'uniswap-v3'),
  pool('0xa2', MON, XNVDA),
  pool('0xa3', XNVDA, WMON, 'nadfun-v2'),
  pool('0xa2', MON, XNVDA),
  pool('0xa4', MON, XNVDA),
]

describe('finding pools for a swap', () => {
  it('lists what a token trades with, for when no pool links the two', () => {
    expect(tradedWith(pairs, XNVDA.address).map((token) => token.symbol)).toEqual(['BLOBY', 'MON', 'WMON'])
    expect(tokensIn(pairs).map((token) => token.symbol)).toEqual(['BLOBY', 'xNVDA', 'MON', 'WMON'])
  })
})

describe('what a swap can sell', () => {
  const balances = (delegate: string | null): WalletBalances => ({ address: '0x', delegate, reserve: (10n * ONE).toString(),
    mon: { balance: (12n * ONE).toString(), usd: null }, tokens: [{ ...XNVDA, balance: '42', usd: null }],
    totalUsd: 0, unpricedAssetCount: 0 })

  it('keeps MON for the fee, and the nad.fun reserve on a delegated wallet', () => {
    expect(sellable(MON, balances(null))).toBe(12n * ONE - 10n ** 17n)
    expect(sellable(MON, balances('0xdelegate'))).toBe(2n * ONE - 10n ** 17n)
  })

  it('sells all of a token, and nothing of one it does not hold', () => {
    expect(sellable(XNVDA, balances(null))).toBe(42n)
    expect(sellable(BLOBY, balances(null))).toBe(0n)
    expect(sellable(BLOBY, null)).toBeNull()
  })
})

describe('balances read from a pool', () => {
  it('replace the wallet list for that pool\'s tokens', () => {
    const base: WalletBalances = { address: '0x', delegate: null, reserve: '0', mon: { balance: '5', usd: 1 },
      tokens: [{ ...XNVDA, balance: '1', usd: 2 }], totalUsd: 0, unpricedAssetCount: 0 }
    const merged = withPairAssets(base, { venue: 'uniswap-v3', id: '0xa1', walletAddress: '0x',
      token0: { ...BLOBY, balance: '7' }, token1: { ...XNVDA, balance: '3' }, monBalance: '9', delegate: null, approvals: [] })
    expect(sellable(BLOBY, merged)).toBe(7n)
    expect(sellable(XNVDA, merged)).toBe(3n)
    expect(merged.tokens.find((token) => token.symbol === 'xNVDA')?.usd).toBe(2)
    expect(merged.mon.balance).toBe('9')
  })
})
