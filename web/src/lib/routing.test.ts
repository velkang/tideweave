import { describe, expect, it } from 'vitest'
import type { PairListItem, PairToken, SwapQuote, SwapRequest } from './explore-api'
import { bestRoute, findRoutes, quoteRoute, routeLabel, WMON, type SwapRoute } from './routing'
import { MON } from './swap-route'

const BLOBY = { address: '0x1111111111111111111111111111111111111111', symbol: 'BLOBY', decimals: 18 }
const XNVDA = { address: '0x2222222222222222222222222222222222222222', symbol: 'xNVDA', decimals: 18 }
const USDC = { address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', symbol: 'USDC', decimals: 6 }
const ONE = 10n ** 18n

const pool = (id: string, token0: PairToken, token1: PairToken, venue: PairListItem['venue'] = 'uniswap-v3'): PairListItem =>
  ({ venue, id, token0, token1, fee: 3000, tickSpacing: 60, hooks: null, sqrtPriceX96: null, tick: 0, liquidity: '1',
    reserve0: null, reserve1: null, memeToken: null, createdBlock: null })

/** Pairs as the API would list them for each token searched. */
function directory(pools: PairListItem[]) {
  const searched: string[] = []
  const pairsOf = async (token: PairToken) => {
    searched.push(token.symbol)
    return pools.filter((pair) => [pair.token0.address, pair.token1.address].some((address) =>
      address.toLowerCase() === token.address.toLowerCase()))
  }
  return { pairsOf, searched }
}
const legs = (route: SwapRoute) => route.legs.map((leg) => leg.kind === 'swap'
  ? `${leg.tokenIn.symbol}>${leg.tokenOut.symbol}@${leg.pool.id}` : leg.kind)

describe('finding a route', () => {
  it('uses a native-MON pool directly', async () => {
    const { pairsOf } = directory([pool('0xn1', MON, XNVDA, 'uniswap-v4')])
    expect((await findRoutes(MON, XNVDA, pairsOf)).map(legs)).toEqual([['MON>xNVDA@0xn1']])
  })

  it('wraps MON first for a pool that holds WMON, and unwraps after selling into one', async () => {
    const { pairsOf } = directory([pool('0xw1', WMON, XNVDA)])
    expect((await findRoutes(MON, XNVDA, pairsOf)).map(legs)).toEqual([['wrap', 'WMON>xNVDA@0xw1']])
    expect((await findRoutes(XNVDA, MON, pairsOf)).map(legs)).toEqual([['xNVDA>WMON@0xw1', 'unwrap']])
  })

  it('never lists all of MON\'s pairs, which would be huge', async () => {
    const { pairsOf, searched } = directory([pool('0xw1', WMON, XNVDA)])
    await findRoutes(MON, XNVDA, pairsOf)
    await findRoutes(XNVDA, MON, pairsOf)
    expect(searched.every((symbol) => symbol !== 'MON' && symbol !== 'WMON')).toBe(true)
  })

  it('goes through a token the target trades with when no pool links the two', async () => {
    const { pairsOf } = directory([pool('0xb1', BLOBY, XNVDA), pool('0xw1', WMON, XNVDA)])
    expect((await findRoutes(MON, BLOBY, pairsOf)).map(legs)).toEqual([['wrap', 'WMON>xNVDA@0xw1', 'xNVDA>BLOBY@0xb1']])
    expect((await findRoutes(BLOBY, MON, pairsOf)).map(legs)).toEqual([['BLOBY>xNVDA@0xb1', 'xNVDA>WMON@0xw1', 'unwrap']])
  })

  it('routes between two tokens through MON or a stablecoin', async () => {
    const { pairsOf } = directory([pool('0xn1', MON, XNVDA, 'uniswap-v4'), pool('0xu1', USDC, BLOBY),
      pool('0xu2', USDC, XNVDA)])
    expect((await findRoutes(XNVDA, BLOBY, pairsOf)).map(legs)).toEqual([['xNVDA>USDC@0xu2', 'USDC>BLOBY@0xu1']])
  })

  it('puts direct routes first, and finds nothing when nothing connects', async () => {
    const { pairsOf } = directory([pool('0xb1', BLOBY, XNVDA), pool('0xw1', WMON, XNVDA), pool('0xw2', WMON, BLOBY)])
    const routes = (await findRoutes(MON, BLOBY, pairsOf)).map(legs)
    expect(routes[0]).toEqual(['wrap', 'WMON>BLOBY@0xw2'])
    expect(routes).toContainEqual(['wrap', 'WMON>xNVDA@0xw1', 'xNVDA>BLOBY@0xb1'])
    expect(await findRoutes(MON, USDC, directory([pool('0xb1', BLOBY, XNVDA)]).pairsOf)).toEqual([])
  })

  it('just wraps or unwraps between MON and WMON', async () => {
    const { pairsOf } = directory([])
    expect((await findRoutes(MON, WMON, pairsOf)).map(legs)).toEqual([['wrap']])
    expect((await findRoutes(WMON, MON, pairsOf)).map(legs)).toEqual([['unwrap']])
  })

  it('names a route by its tokens', async () => {
    const { pairsOf } = directory([pool('0xb1', BLOBY, XNVDA), pool('0xw1', WMON, XNVDA)])
    const [route] = await findRoutes(MON, BLOBY, pairsOf)
    expect(routeLabel(route)).toBe('MON → WMON → xNVDA → BLOBY')
  })
})

describe('quoting a route', () => {
  const quote = (amountOut: bigint, minimum: bigint, extra: Partial<SwapQuote> = {}): SwapQuote => ({ tokenOut: '0x',
    amountOut: amountOut.toString(), amountOutMinimum: minimum.toString(), priceImpactBps: 10, tooMuchImpact: false,
    balance: '0', allowances: [], approved: true, ...extra })

  it('passes each leg\'s output on, wraps 1:1, and compounds the minimums', async () => {
    const { pairsOf } = directory([pool('0xb1', BLOBY, XNVDA), pool('0xw1', WMON, XNVDA)])
    const [route] = await findRoutes(MON, BLOBY, pairsOf)
    const asked: SwapRequest[] = []
    const quoted = await quoteRoute(route, ONE, 100, async (request) => {
      asked.push(request)
      return request.tokenIn === WMON.address ? quote(4n * ONE, 396n * ONE / 100n) : quote(2n * ONE, 198n * ONE / 100n)
    })
    expect(asked.map((request) => [request.pairId, request.amountIn])).toEqual([['0xw1', ONE.toString()],
      ['0xb1', (4n * ONE).toString()]])
    expect(quoted.amountOut).toBe(2n * ONE)
    // Two swaps at 1% each: 2 × 0.99 × 0.99.
    expect(quoted.minimumOut).toBe(2n * ONE * 9801n / 10000n)
    expect(quoted.swapQuotes).toHaveLength(2)
    expect(quoted.tooMuchImpact).toBe(false)
  })

  it('flags a route when any leg moves the price too much, and prefers routes that do not', async () => {
    const { pairsOf } = directory([pool('0xb1', BLOBY, XNVDA), pool('0xw1', WMON, XNVDA), pool('0xw2', WMON, BLOBY)])
    const routes = await findRoutes(MON, BLOBY, pairsOf)
    const quoted = await Promise.all(routes.map((route) => quoteRoute(route, ONE, 100, async (request) =>
      request.pairId === '0xw2' ? quote(9n * ONE, 0n, { tooMuchImpact: true }) : quote(3n * ONE, 0n))))
    expect(quoted.find((entry) => entry.route.legs.some((leg) => leg.kind === 'swap' && leg.pool.id === '0xw2'))
      ?.tooMuchImpact).toBe(true)
    expect(legs(bestRoute(quoted)!.route)).toEqual(['wrap', 'WMON>xNVDA@0xw1', 'xNVDA>BLOBY@0xb1'])
    expect(bestRoute([])).toBeNull()
  })
})
