import type { PairDetail } from './explore-api'

// A starting amount for the swap a deposit needs. The live quote is what the user reviews.

const BPS = 10_000n
/** Added on top of the pool fee, for price movement between the estimate and the swap. */
const MARGIN_BPS = 100n
/** Assumed when the fee isn't known: v4 dynamic fees, and nad.fun's router fees, which vary by pair. */
const UNKNOWN_FEE_BPS = 100n
const DYNAMIC_FEE = 0x800000
const Q192 = 2n ** 192n

const ceilDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator

function uniswapFeeBps(fee: number | undefined) {
  if (fee === undefined || fee === DYNAMIC_FEE) return UNKNOWN_FEE_BPS
  return BigInt(Math.ceil(fee / 100))
}

/**
 * About how much of the pair's other token to sell to receive `needed` of token `receiveIndex`, in raw
 * units. v3 and v4 use the pool price, so a large swap in a thin pool will fall short; nad.fun uses its
 * reserves, which includes the pool moving. Null when the pair has no price or can't supply that much.
 */
export function estimateSwapInput(pair: PairDetail, receiveIndex: 0 | 1, needed: bigint): bigint | null {
  if (needed <= 0n) return null
  if (pair.venue === 'nadfun-v2') {
    if (!pair.reserve0 || !pair.reserve1) return null
    const [reserveIn, reserveOut] = receiveIndex === 0
      ? [BigInt(pair.reserve1), BigInt(pair.reserve0)] : [BigInt(pair.reserve0), BigInt(pair.reserve1)]
    if (reserveIn === 0n || needed >= reserveOut) return null
    return ceilDiv(reserveIn * needed * (BPS + UNKNOWN_FEE_BPS + MARGIN_BPS), (reserveOut - needed) * BPS)
  }
  if (!pair.sqrtPriceX96 || BigInt(pair.sqrtPriceX96) === 0n) return null
  const priceX192 = BigInt(pair.sqrtPriceX96) ** 2n
  const scale = BPS + uniswapFeeBps(pair.fee) + MARGIN_BPS
  // The raw price is token1 per token0: priceX192 / 2^192.
  return receiveIndex === 1
    ? ceilDiv(needed * Q192 * scale, priceX192 * BPS)
    : ceilDiv(needed * priceX192 * scale, Q192 * BPS)
}

const SHOWN_DECIMALS = 6

/** A raw amount rounded up to at most six decimal places, so it reads cleanly in a form. */
export function roundUpAmount(raw: bigint, decimals: number) {
  const step = 10n ** BigInt(Math.max(0, decimals - SHOWN_DECIMALS))
  return ceilDiv(raw, step) * step
}
