import { useCallback, useEffect, useState } from 'react'
import { exploreApi, type PairAssets, type PairToken } from '../../lib/explore-api'
import { errorText } from '../../lib/format'
import { bestRoute, findRoutes, quoteRoute, type RouteQuote, type SwapRoute } from '../../lib/routing'
import { isMon, pairsOf, tradedWith } from '../../lib/swap-route'

const QUOTE_DELAY_MS = 400

export type RouteState =
  | { status: 'idle' | 'finding' }
  | { status: 'none'; alternatives: PairToken[] }
  | { status: 'ready'; routes: SwapRoute[] }
  | { status: 'error'; message: string }

/** The first pool a route swaps in, whose exact balance reads cover the token being sold. */
const firstPool = (routes: SwapRoute[]) => {
  for (const leg of routes[0]?.legs ?? []) if (leg.kind === 'swap') return leg.pool
  return null
}

/**
 * Finds the routes that swap `sell` for `receive` (one pool, or through one token in between, wrapping MON where a
 * pool holds WMON), quotes `amountIn` along each, and keeps the one that returns the most. `enabled` is false
 * until the user is signed in.
 */
export function useSwapRoute(sell: PairToken, receive: PairToken | null, amountIn: bigint, slippageBps: number,
  enabled: boolean) {
  const [route, setRoute] = useState<RouteState>({ status: 'idle' })
  const [assets, setAssets] = useState<PairAssets | null>(null)
  const [best, setBest] = useState<RouteQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setBest(null); setAssets(null); setError('')
    if (!receive) { setRoute({ status: 'idle' }); return }
    let active = true
    setRoute({ status: 'finding' })
    findRoutes(sell, receive, pairsOf).then(async (routes) => {
      if (!active) return
      if (routes.length > 0) { setRoute({ status: 'ready', routes }); return }
      const alternatives = isMon(receive) ? [] : tradedWith(await pairsOf(receive), receive.address)
      if (active) setRoute({ status: 'none', alternatives })
    }).catch((reason) => { if (active) setRoute({ status: 'error', message: errorText(reason) }) })
    return () => { active = false }
  }, [sell.address, receive?.address]) // eslint-disable-line react-hooks/exhaustive-deps

  const routes = route.status === 'ready' ? route.routes : null
  const loadAssets = useCallback(async () => {
    const pool = routes ? firstPool(routes) : null
    if (!pool || !enabled) { setAssets(null); return }
    try { setAssets(await exploreApi.getPairAssets(pool.venue, pool.id)) } catch { setAssets(null) }
  }, [routes, enabled])
  useEffect(() => { void loadAssets() }, [loadAssets])

  const slippageValid = Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 500
  const requote = useCallback(async () => {
    if (!routes || !enabled || amountIn <= 0n || !slippageValid) { setBest(null); setError(''); return }
    setQuoting(true)
    const results = await Promise.allSettled(routes.map((entry) =>
      quoteRoute(entry, amountIn, slippageBps, (request) => exploreApi.quoteSwap(request))))
    const quotes = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const failure = results.find((result) => result.status === 'rejected')
    setBest(bestRoute(quotes))
    setError(quotes.length === 0 && failure?.status === 'rejected' ? errorText(failure.reason) : '')
    setQuoting(false)
  }, [routes, enabled, amountIn, slippageBps]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBest(null)
    const timer = setTimeout(() => void requote(), QUOTE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [requote])

  return { route, assets, best, quoting, error, requote, loadAssets }
}
