import { describe, expect, it } from 'vitest'
import type { PairDetail } from './explore-api'
import { estimateSwapInput, roundUpAmount } from './swap-estimate'

const WMON = { address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', symbol: 'WMON', decimals: 18 }
const USDC = { address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', symbol: 'USDC', decimals: 6 }
const MEME = { address: '0x1111111111111111111111111111111111111111', symbol: 'MEME', decimals: 18 }
const ONE = 10n ** 18n

// 1 WMON = 0.03 USDC: raw price 0.03e6 / 1e18 = 3e-14 token1 units per token0 unit.
const v3: PairDetail = { venue: 'uniswap-v3', id: '0x3333333333333333333333333333333333333333', token0: WMON,
  token1: USDC, fee: 3000, tickSpacing: 60, sqrtPriceX96: BigInt(Math.round(Math.sqrt(3e-14) * 2 ** 96)).toString() }

describe('estimating how much to sell for a deposit', () => {
  it('sells token0 for token1 at the pool price plus the fee and a 1% margin', () => {
    // 3 USDC needs 100 WMON at the pool price; 0.3% fee + 1% margin = 101.3 WMON.
    const amount = estimateSwapInput(v3, 1, 3_000_000n)!
    expect(Number(amount) / 1e18).toBeCloseTo(101.3, 3)
  })

  it('sells token1 for token0', () => {
    // 100 WMON costs 3 USDC; with 1.3% added, 3.039 USDC.
    expect(Number(estimateSwapInput(v3, 0, 100n * ONE))).toBeCloseTo(3_039_000, -1)
  })

  it('assumes a 1% fee for a dynamic-fee v4 pool', () => {
    const dynamic: PairDetail = { ...v3, venue: 'uniswap-v4', id: `0x${'44'.repeat(32)}`, fee: 0x800000 }
    expect(Number(estimateSwapInput(dynamic, 0, 100n * ONE))).toBeCloseTo(3_060_000, -1)
  })

  it('uses the constant-product formula for nad.fun, so the pool moving is included', () => {
    const nad: PairDetail = { venue: 'nadfun-v2', id: '0x5555555555555555555555555555555555555555', token0: MEME,
      token1: WMON, reserve0: (1_000n * ONE).toString(), reserve1: (1_000n * ONE).toString() }
    // Taking 100 of 1,000 MEME needs 1000*100/900 = 111.11 WMON before fees; with 2% added, 113.33.
    expect(Number(estimateSwapInput(nad, 0, 100n * ONE)) / 1e18).toBeCloseTo(113.333, 2)
  })

  it('has no estimate when the pool cannot supply that much or has no price', () => {
    const nad: PairDetail = { venue: 'nadfun-v2', id: '0x5555555555555555555555555555555555555555', token0: MEME,
      token1: WMON, reserve0: (1_000n * ONE).toString(), reserve1: (1_000n * ONE).toString() }
    expect(estimateSwapInput(nad, 0, 1_000n * ONE)).toBeNull()
    expect(estimateSwapInput({ ...v3, sqrtPriceX96: undefined }, 1, 1n)).toBeNull()
    expect(estimateSwapInput(v3, 1, 0n)).toBeNull()
  })
})

describe('rounding an estimate for the amount field', () => {
  it('rounds up to six decimal places, so the estimate never shrinks', () => {
    expect(roundUpAmount(101_300_000_000_000_000_001n, 18)).toBe(101_300_001_000_000_000_000n)
    expect(roundUpAmount(3_039_001n, 6)).toBe(3_039_001n)
    expect(roundUpAmount(7n, 2)).toBe(7n)
  })
})
