import { formatUnits, parseUnits } from 'viem'
import { ApiError } from './api-client'
import type { PairDetail, PairListItem, Venue } from './explore-api'

export const VENUE_LABEL: Record<Venue, string> = {
  'uniswap-v3': 'Uniswap v3',
  'uniswap-v4': 'Uniswap v4',
  'nadfun-v2': 'nad.fun',
}

export const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`

/** A raw token amount in whole units, without trailing zeros. */
export function formatAmount(raw: string | bigint, decimals: number) {
  const value = formatUnits(BigInt(raw), decimals)
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

/**
 * A raw amount for an input field: six decimals, or six significant digits when smaller, rounded down so a
 * filled-in amount never exceeds what it was computed from.
 */
export function formatInput(raw: bigint, decimals: number) {
  if (raw <= 0n) return ''
  const [whole, fraction = ''] = formatUnits(raw, decimals).split('.')
  const leadingZeros = whole === '0' ? fraction.length - fraction.replace(/^0+/, '').length : 0
  const kept = fraction.slice(0, Math.max(6, leadingZeros + 6)).replace(/0+$/, '')
  return kept ? `${whole}.${kept}` : whole
}

/** Whole units typed by the user, as a positive raw amount. */
export function rawAmount(text: string, decimals: number) {
  const amount = parseUnits(text.trim(), decimals)
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.')
  return amount
}

export function formatFee(fee: number | null | undefined) {
  if (fee === null || fee === undefined) return '0.25% LP fee'
  // v4 marks a dynamic fee with the top bit of the 24-bit fee.
  if (fee === 0x800000) return 'Dynamic fee'
  return `${fee / 10_000}%`
}

const significant = (price: number) =>
  Number.isFinite(price) && price > 0 ? price.toPrecision(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : 'unavailable'

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'
const COMPACT: ReadonlyArray<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']]

/**
 * A price people can read at a glance: "59.36M" for big numbers, "1,234.5" for thousands, six significant
 * digits in between, and "0.0₇1684" (seven zeros after the point) for tiny ones, never "1.68e-8".
 */
export function formatPrice(price: number) {
  if (!Number.isFinite(price) || !(price > 0)) return 'unavailable'
  const big = COMPACT.find(([size]) => price >= size)
  if (big) return `${Number((price / big[0]).toPrecision(4))}${big[1]}`
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (price >= 1e-4) return significant(price)
  const zeros = -Math.floor(Math.log10(price)) - 1
  const digits = Math.round(price * 10 ** (zeros + 4)).toString().replace(/0+$/, '')
  return `0.0${String(zeros).split('').map((digit) => SUBSCRIPT[Number(digit)]).join('')}${digits}`
}

/** A price to type into a field: plain decimals, never exponent notation. */
export function plainPrice(price: number) {
  if (!Number.isFinite(price) || !(price > 0)) return ''
  if (price >= 1e-4) return significant(price).includes('e') ? price.toFixed(0) : significant(price)
  const zeros = -Math.floor(Math.log10(price)) - 1
  return price.toFixed(Math.min(20, zeros + 6)).replace(/0+$/, '')
}

/** token1 per token0 at a tick. */
export function tickPrice(tick: number, pair: Pick<PairDetail, 'token0' | 'token1'>) {
  return formatPrice(1.0001 ** tick * 10 ** (pair.token0.decimals - pair.token1.decimals))
}

/** token1 per token0 now: from the tick for v3 and v4, from reserves for nad.fun. */
export function pairPrice(pair: PairDetail | PairListItem) {
  if (pair.venue === 'nadfun-v2') {
    if (!pair.reserve0 || !pair.reserve1 || pair.reserve0 === '0') return 'unavailable'
    return formatPrice(Number(formatUnits(BigInt(pair.reserve1), pair.token1.decimals)) /
      Number(formatUnits(BigInt(pair.reserve0), pair.token0.decimals)))
  }
  return typeof pair.tick === 'number' ? tickPrice(pair.tick, pair) : 'unavailable'
}

/** A readable message for an API error code. */
export function errorText(error: unknown) {
  if (error instanceof ApiError && error.status === 429) return error.message;
  const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error)
  const known: Record<string, string> = {
    INTERNAL_ERROR: 'The service could not complete this request. Try again in a moment.',
    INSUFFICIENT_MON_RESERVE: 'Keep at least 10 MON in the wallet plus gas: Monad requires it while the wallet is set up for nad.fun.',
    INSUFFICIENT_MON_FOR_GAS: 'Add a little MON to the managed wallet for gas.',
    INSUFFICIENT_TOKEN_BALANCE: 'The managed wallet does not hold enough of a pool token.',
    TOKEN_APPROVAL_REQUIRED: 'Approve both token amounts first.',
    ERC20_APPROVAL_REQUIRED: 'Approve the token for Permit2 first.',
    PERMIT2_APPROVAL_REQUIRED: 'Finish the Permit2 approval first.',
    POOL_NOT_GRADUATED: 'This nad.fun token has not graduated to its pool yet.',
    DELEGATION_UNEXPECTED: 'The wallet is delegated to an unknown contract; contact support before continuing.',
    BOTH_TOKENS_REQUIRED: 'This range would take only one token. Choose a range that includes today\'s price, so it holds both tokens.',
    MINT_SIMULATION_FAILED: 'The pool would not accept this deposit right now. Nothing was sent; try again or change the amounts.',
    V4_MINT_SIMULATION_FAILED: 'The pool would not accept this deposit right now. Nothing was sent; try again or change the amounts.',
    NAD_BATCH_SIMULATION_FAILED: 'The pair would not accept this deposit right now. Nothing was sent; try again or change the amounts.',
    APPROVAL_SIMULATION_FAILED: 'The approval would fail right now. Nothing was sent.',
    V4_APPROVAL_SIMULATION_FAILED: 'The approval would fail right now. Nothing was sent.',
    POOL_NOT_AVAILABLE: 'This pool is no longer available.',
    POOL_ALMOST_EMPTY: 'This pool is almost empty, so its price can\'t be trusted. Nothing was sent.',
    PRICE_IMPACT_TOO_HIGH: 'This pool is too thin for that amount: the price would move more than 5% against you.',
    INSUFFICIENT_MON: 'Add a little MON to the managed wallet for gas.',
    WALLET_NOT_ACTIVE: 'The managed wallet is not active.',
    SAFE_BLOCK_UNAVAILABLE: 'Monad did not return a recent block. Try again in a moment.',
    MAINNET_SIGNING_FAILED: 'The signing service could not sign this. Nothing was sent; try again.',
    MINIMUM_NO_LONGER_MET: 'The price moved since the preview. Nothing was sent; review it again.',
    AUTOMATION_RUNNING: 'Automation is using this wallet. Wait for the run to finish, or pause its mandate.',
    AUTOMATION_VALUATION_UNAVAILABLE: 'This position needs a stablecoin or MON/WMON anchor with enough liquidity for a reliable valuation.',
    AUTOMATION_UNAVAILABLE: 'The automation service is unavailable. Try again later.',
    MANDATE_NOT_ACTIVE: 'This mandate is paused or revoked. No further steps will be submitted.',
    MANDATE_LIMIT_TOO_LOW: 'Increase the position limit to cover the current value and reopening headroom.',
    MANDATE_LIMIT_OR_BAND_CHANGED: 'The position value or range changed. Review the mandate before approving.',
    MANDATE_POSITION_OR_BAND_MISMATCH: 'This mandate covers a different position or range. Update it before rebalancing.',
    MANDATE_DAILY_LIMIT_REACHED: 'This mandate has reached its run limit for the last 24 hours.',
    RUN_IN_PROGRESS: 'A run already owns this wallet. Wait for it to finish.',
    POSITION_NOT_OWNED: 'This position is not a Tideweave-created position held by your managed wallet.',
    POSITION_EMPTY: 'This position has already been closed.',
    EMERGENCY_STOP_ACTIVE: 'Deposits are paused right now. Exits still work.',
  }
  return known[code] ?? code
}

/** A raw amount for reading: six decimals, or six significant digits when smaller; "0" when empty. */
export const formatToken = (raw: string | bigint, decimals: number) => formatInput(BigInt(raw), decimals) || '0'
