import { MONAD_STABLES, MONAD_TOKENS } from '@tideweave/chain'
import type { PairListItem, PairToken, SwapQuote, SwapRequest } from './explore-api'
import { isMon, MON, sameToken, tradedWith } from './swap-route'

// Swap routes from any token to any other: straight through one pool, or through one token in between (MON or
// a stablecoin first). Native MON and WMON count as the same token; a wrap or unwrap step joins them where a
// pool holds the other one.

export const WMON: PairToken = { address: MONAD_TOKENS.WMON, symbol: 'WMON', decimals: 18 }
export const isWmon = (token: PairToken) => sameToken(token.address, WMON.address)
const isMonForm = (token: PairToken) => isMon(token) || isWmon(token)
const formsOf = (token: PairToken) => isMonForm(token) ? [MON, WMON] : [token]

export type RouteLeg = { kind: 'wrap' } | { kind: 'unwrap' } |
  { kind: 'swap'; pool: PairListItem; tokenIn: PairToken; tokenOut: PairToken }
export type SwapRoute = { sell: PairToken; receive: PairToken; legs: RouteLeg[] }
export type PairsOf = (token: PairToken) => Promise<PairListItem[]>

/** Routes compared per swap, and pools tried per leg and in-between tokens per route: enough to find a good price. */
const MAX_ROUTES = 6
const POOLS_PER_LEG = 2
const MAX_CONNECTORS = 4

type Hop = { pool: PairListItem; tokenIn: PairToken; tokenOut: PairToken }

const tokenIn = (pair: PairListItem, forms: PairToken[]) =>
  forms.some((form) => sameToken(pair.token0.address, form.address)) ? pair.token0 : pair.token1

/** Pools in `pairs` trading any form of `a` for any form of `b`, at most POOLS_PER_LEG, as hops from a to b. */
function hopsBetween(pairs: readonly PairListItem[], a: PairToken, b: PairToken): Hop[] {
  const [fromForms, toForms] = [formsOf(a), formsOf(b)]
  const has = (pair: PairListItem, forms: PairToken[]) =>
    forms.some((form) => sameToken(pair.token0.address, form.address) || sameToken(pair.token1.address, form.address))
  const seen = new Set<string>()
  return pairs.filter((pair) => {
    const key = `${pair.venue}:${pair.id.toLowerCase()}`
    if (seen.has(key) || !has(pair, fromForms) || !has(pair, toForms)) return false
    seen.add(key)
    return true
  }).slice(0, POOLS_PER_LEG).map((pool) => {
    const input = tokenIn(pool, fromForms)
    return { pool, tokenIn: input, tokenOut: sameToken(input.address, pool.token0.address) ? pool.token1 : pool.token0 }
  })
}

/** The step that turns `from` into `to` when they are MON and WMON, null when they are the same, undefined if neither. */
function conversion(from: PairToken, to: PairToken): RouteLeg | null | undefined {
  if (sameToken(from.address, to.address)) return null
  if (isMon(from) && isWmon(to)) return { kind: 'wrap' }
  if (isWmon(from) && isMon(to)) return { kind: 'unwrap' }
  return undefined
}

/** Joins hops into steps from `sell` to `receive`, adding a wrap or unwrap wherever MON meets WMON. */
function assemble(sell: PairToken, hops: Hop[], receive: PairToken): SwapRoute | null {
  const legs: RouteLeg[] = []
  let current = sell
  for (const next of [...hops.map((hop) => ({ input: hop.tokenIn, hop })), { input: receive, hop: null }]) {
    const step = conversion(current, next.input)
    if (step === undefined) return null
    if (step) legs.push(step)
    if (next.hop) { legs.push({ kind: 'swap', ...next.hop }); current = next.hop.tokenOut }
  }
  return legs.length > 0 ? { sell, receive, legs } : null
}

/** In-between tokens to try: MON first, then stablecoins, then the rest, never either end of the swap. */
function connectors(pairs: readonly PairListItem[], from: PairToken, sell: PairToken, receive: PairToken): PairToken[] {
  const ends = [...formsOf(sell), ...formsOf(receive)]
  const rank = (token: PairToken) => isMonForm(token) ? 0 : MONAD_STABLES.some((stable) => sameToken(stable, token.address)) ? 1 : 2
  const seen = new Set<string>()
  return formsOf(from).flatMap((form) => tradedWith(pairs, form.address))
    .filter((token) => !ends.some((end) => sameToken(end.address, token.address)))
    .map((token) => isMonForm(token) ? WMON : token)
    .filter((token) => { const key = token.address.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true })
    .sort((a, b) => rank(a) - rank(b)).slice(0, MAX_CONNECTORS)
}

/**
 * Up to MAX_ROUTES routes from `sell` to `receive`, direct ones first. MON's own pair list is never read (it is
 * huge): pools touching MON are found from the other token's pairs.
 */
export async function findRoutes(sell: PairToken, receive: PairToken, pairsOf: PairsOf): Promise<SwapRoute[]> {
  if (isMonForm(sell) && isMonForm(receive)) {
    const route = assemble(sell, [], receive)
    return route ? [route] : []
  }
  const cache = new Map<string, Promise<PairListItem[]>>()
  const pairsFor = (token: PairToken) => {
    const key = token.address.toLowerCase()
    if (!cache.has(key)) cache.set(key, pairsOf(token))
    return cache.get(key)!
  }
  const [sellPairs, receivePairs] = await Promise.all([isMonForm(sell) ? null : pairsFor(sell),
    isMonForm(receive) ? null : pairsFor(receive)])
  const known = (receivePairs ?? sellPairs)!
  const routes: SwapRoute[] = hopsBetween(known, sell, receive)
    .map((hop) => assemble(sell, [hop], receive)).filter((route): route is SwapRoute => route !== null)

  // Connectors come from the side whose pairs are known: what the receive token trades with, else the sell token.
  const anchor = receivePairs ? receive : sell
  for (const connector of connectors(known, anchor, sell, receive)) {
    // A side's own pairs answer its leg; a MON connector is never looked up, so the other side must be known.
    const firstPairs = sellPairs ?? (isMonForm(connector) ? null : await pairsFor(connector))
    const secondPairs = receivePairs ?? (isMonForm(connector) ? null : await pairsFor(connector))
    if (!firstPairs || !secondPairs) continue
    for (const first of hopsBetween(firstPairs, sell, connector)) {
      for (const second of hopsBetween(secondPairs, connector, receive)) {
        const route = assemble(sell, [first, second], receive)
        if (route) routes.push(route)
      }
    }
  }
  return routes.slice(0, MAX_ROUTES)
}

/** The tokens a route passes through, for one line in the swap form: "MON → WMON → xNVDA → BLOBY". */
export function routeLabel(route: SwapRoute) {
  const tokens = [route.sell, ...route.legs.map((leg) => leg.kind === 'wrap' ? WMON : leg.kind === 'unwrap' ? MON : leg.tokenOut)]
  return tokens.map((token) => token.symbol).join(' → ')
}

export type RouteQuote = { route: SwapRoute; amountIn: bigint; amountOut: bigint; minimumOut: bigint;
  /** One quote per swap step, in order: each carries the allowances that step still needs. */
  swapQuotes: SwapQuote[]; priceImpactBps: number; tooMuchImpact: boolean }

/**
 * Quotes a route by passing each step's output to the next (a wrap or unwrap is 1:1). The minimum compounds each
 * swap's slippage, so it is what the route returns if every step fills at its worst allowed price.
 */
export async function quoteRoute(route: SwapRoute, amountIn: bigint, slippageBps: number,
  quote: (request: SwapRequest) => Promise<SwapQuote>): Promise<RouteQuote> {
  let amount = amountIn
  const swapQuotes: SwapQuote[] = []
  for (const leg of route.legs) {
    if (leg.kind !== 'swap') continue
    const quoted = await quote({ venue: leg.pool.venue, pairId: leg.pool.id, tokenIn: leg.tokenIn.address,
      amountIn: amount.toString(), slippageBps })
    swapQuotes.push(quoted)
    amount = BigInt(quoted.amountOut)
  }
  const keep = BigInt(10_000 - slippageBps) ** BigInt(swapQuotes.length)
  const minimumOut = swapQuotes.length === 0 ? amount : amount * keep / 10_000n ** BigInt(swapQuotes.length)
  return { route, amountIn, amountOut: amount, minimumOut, swapQuotes,
    priceImpactBps: Math.max(0, ...swapQuotes.map((entry) => entry.priceImpactBps)),
    tooMuchImpact: swapQuotes.some((entry) => entry.tooMuchImpact) }
}

/** The route that returns the most within the price impact limit, or the best over it so the warning can show. */
export function bestRoute(quotes: readonly RouteQuote[]): RouteQuote | null {
  const byOutput = [...quotes].sort((a, b) => a.amountOut === b.amountOut ? 0 : a.amountOut < b.amountOut ? 1 : -1)
  return byOutput.find((entry) => !entry.tooMuchImpact) ?? byOutput[0] ?? null
}
