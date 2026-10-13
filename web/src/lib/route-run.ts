import { retryWhileCatchingUp } from './deposit-flow'
import type { RunIntent } from './execute'
import { exploreApi, type PairAssets, type PairToken, type SwapQuote } from './explore-api'
import { quoteRoute, WMON, type RouteLeg, type RouteQuote, type SwapRoute } from './routing'
import { isMon, MON, sameToken } from './swap-route'

// Runs a routed swap one step at a time. Each later step sells what the step before it actually returned, and
// before each swap the rest of the route is quoted again: if it would now return less than the minimum the user
// reviewed, the route stops and what the wallet holds so far stays there.

export type RouteApi = Pick<typeof exploreApi, 'quoteSwap' | 'prepareSwap' | 'prepareSwapApproval' | 'prepareWrap' |
  'getPairAssets'>

export type RouteOutcome = { status: 'done' } |
  { status: 'stopped'; reason: 'failed' | 'pending' | 'price'; step: number; holding: PairToken }

const key = () => crypto.randomUUID()
// Permit2 approvals last a little under the API's three-day limit.
const permit2Expiry = () => String(Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60 - 600)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Reads of a step's output, while the API's safe block catches up with the step that just confirmed. */
const BALANCE_READS = 8

export function legLabel(leg: RouteLeg) {
  if (leg.kind === 'wrap') return 'Wrap MON'
  if (leg.kind === 'unwrap') return 'Unwrap WMON'
  return `Swap ${leg.tokenIn.symbol} for ${leg.tokenOut.symbol}`
}

const legOutput = (leg: RouteLeg) => leg.kind === 'wrap' ? WMON : leg.kind === 'unwrap' ? MON : leg.tokenOut

/** Approvals a swap step still needs, in order: the ERC-20 one, then Permit2's (v4). */
function approvalsNeeded(quote: SwapQuote, amount: bigint) {
  const soon = BigInt(Math.floor(Date.now() / 1000) + 900)
  return quote.allowances.filter((item) => BigInt(item.allowance) < amount ||
    (item.stage === 'permit2' && BigInt(item.expiration ?? '0') <= soon))
}

const balanceIn = (assets: PairAssets, token: PairToken) => isMon(token) ? BigInt(assets.monBalance)
  : BigInt((sameToken(assets.token0.address, token.address) ? assets.token0 : assets.token1).balance)

export async function runRoute(input: { quoted: RouteQuote; slippageBps: number; api: RouteApi; run: RunIntent;
  onStep: (index: number) => void; wait?: () => Promise<void> }): Promise<RouteOutcome> {
  const { quoted, slippageBps, api, run } = input
  const wait = input.wait ?? (() => pause(1500))
  const { legs } = quoted.route
  let amount = quoted.amountIn
  let holding = quoted.route.sell
  for (const [index, leg] of legs.entries()) {
    input.onStep(index)
    const stop = (reason: 'failed' | 'pending' | 'price'): RouteOutcome => ({ status: 'stopped', reason, step: index, holding })
    if (leg.kind !== 'swap') {
      const result = await run(legLabel(leg), () => retryWhileCatchingUp(() =>
        api.prepareWrap({ action: leg.kind, amount: amount.toString(), idempotencyKey: key() })))
      if (result !== 'confirmed') return stop(result)
      holding = legOutput(leg)
      continue
    }
    // The rest of the route, quoted again from what is held now, must still reach the reviewed minimum.
    const rest: SwapRoute = { sell: holding, receive: quoted.route.receive, legs: legs.slice(index) }
    const ahead = await quoteRoute(rest, amount, slippageBps, (request) => api.quoteSwap(request))
    if (ahead.amountOut < quoted.minimumOut || ahead.tooMuchImpact) return stop('price')
    for (const approval of approvalsNeeded(ahead.swapQuotes[0], amount)) {
      const result = await run(`Allow ${leg.tokenIn.symbol}`, () => retryWhileCatchingUp(() => api.prepareSwapApproval({
        venue: leg.pool.venue, pairId: leg.pool.id, tokenAddress: leg.tokenIn.address, stage: approval.stage,
        amount: amount.toString(), ...(approval.stage === 'permit2' ? { expiration: permit2Expiry() } : {}),
        idempotencyKey: key() })))
      if (result !== 'confirmed') return stop(result)
    }
    const before = balanceIn(await api.getPairAssets(leg.pool.venue, leg.pool.id), leg.tokenOut)
    const result = await run(legLabel(leg), () => retryWhileCatchingUp(() => api.prepareSwap({ venue: leg.pool.venue,
      pairId: leg.pool.id, tokenIn: leg.tokenIn.address, amountIn: amount.toString(), slippageBps, idempotencyKey: key() })))
    if (result !== 'confirmed') return stop(result)
    holding = leg.tokenOut
    amount = await received(api, leg, before, BigInt(ahead.swapQuotes[0].amountOutMinimum), wait)
  }
  return { status: 'done' }
}

/**
 * What a confirmed swap step returned: the rise in its output balance, read until the safe block shows it. Falls
 * back to the step's minimum, which the swap guaranteed, if the rise doesn't show in time.
 */
async function received(api: RouteApi, leg: Extract<RouteLeg, { kind: 'swap' }>, before: bigint, minimum: bigint,
  wait: () => Promise<void>): Promise<bigint> {
  for (let read = 0; read < BALANCE_READS; read += 1) {
    const after = balanceIn(await api.getPairAssets(leg.pool.venue, leg.pool.id), leg.tokenOut)
    if (after > before) return after - before
    await wait()
  }
  return minimum
}
