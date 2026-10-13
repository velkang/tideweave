import { describe, expect, it } from 'vitest'
import type { PairAssets, PairListItem, PairToken, Prepared, SwapQuote, SwapRequest } from './explore-api'
import { runRoute, type RouteApi } from './route-run'
import { findRoutes, quoteRoute, WMON } from './routing'
import { MON } from './swap-route'

const BLOBY = { address: '0x1111111111111111111111111111111111111111', symbol: 'BLOBY', decimals: 18 }
const XNVDA = { address: '0x2222222222222222222222222222222222222222', symbol: 'xNVDA', decimals: 18 }
const ONE = 10n ** 18n
const pool = (id: string, token0: PairToken, token1: PairToken): PairListItem => ({ venue: 'uniswap-v3', id, token0, token1,
  fee: 3000, tickSpacing: 60, hooks: null, sqrtPriceX96: null, tick: 0, liquidity: '1', reserve0: null, reserve1: null,
  memeToken: null, createdBlock: null })
const pools = [pool('0xb1', BLOBY, XNVDA), pool('0xw1', WMON, XNVDA)]
const pairsOf = async (token: PairToken) => pools.filter((pair) => [pair.token0.address, pair.token1.address]
  .some((address) => address.toLowerCase() === token.address.toLowerCase()))

/** A wallet whose swaps pay `rate` of the input (minus a little), with allowances to set up first. */
function fakeChain(options: { rate?: Record<string, bigint>; approvalsNeeded?: boolean; failAt?: string;
  /** A pool's new rate once the first swap has run, as if the market moved between steps. */
  laterRate?: Record<string, bigint> } = {}) {
  const balances = new Map<string, bigint>([[MON.address, 50n * ONE]])
  let rate = options.rate ?? { '0xw1': 4n, '0xb1': 2n }
  const calls: string[] = []
  const approved = new Set<string>()
  const add = (token: string, amount: bigint) => balances.set(token.toLowerCase(), (balances.get(token.toLowerCase()) ?? 0n) + amount)
  add(MON.address, 0n)
  const quote = (request: SwapRequest): SwapQuote => {
    const out = BigInt(request.amountIn) * rate[request.pairId]
    const allowances = options.approvalsNeeded && !approved.has(`${request.pairId}:${request.tokenIn}`)
      ? [{ stage: 'erc20' as const, spender: '0xrouter', allowance: '0' }] : []
    return { tokenOut: '0x', amountOut: out.toString(), amountOutMinimum: (out * 99n / 100n).toString(), priceImpactBps: 10,
      tooMuchImpact: false, balance: '0', allowances, approved: allowances.length === 0 }
  }
  const api: RouteApi = {
    quoteSwap: async (request) => quote(request),
    prepareSwapApproval: async (body) => { calls.push(`approve ${body.pairId} ${body.amount}`);
      approved.add(`${body.pairId}:${body.tokenAddress}`); return { intentId: 'a', status: 'pending' } },
    prepareSwap: async (body) => {
      calls.push(`swap ${body.pairId} ${body.amountIn}`)
      const pair = pools.find((entry) => entry.id === body.pairId)!
      const out = pair.token0.address === body.tokenIn ? pair.token1 : pair.token0
      add(body.tokenIn, -BigInt(body.amountIn)); add(out.address, BigInt(quote(body).amountOut))
      if (options.laterRate) rate = { ...rate, ...options.laterRate }
      return { intentId: `swap-${body.pairId}`, status: 'pending' }
    },
    prepareWrap: async (body) => {
      calls.push(`${body.action} ${body.amount}`)
      const [from, to] = body.action === 'wrap' ? [MON, WMON] : [WMON, MON]
      add(from.address, -BigInt(body.amount)); add(to.address, BigInt(body.amount))
      return { intentId: body.action, status: 'pending' }
    },
    getPairAssets: async (_venue, id) => {
      const pair = pools.find((entry) => entry.id === id)!
      const read = (token: PairToken) => ({ ...token, balance: (balances.get(token.address.toLowerCase()) ?? 0n).toString() })
      return { venue: 'uniswap-v3', id, walletAddress: '0x', token0: read(pair.token0), token1: read(pair.token1),
        monBalance: (balances.get(MON.address) ?? 0n).toString(), delegate: null, approvals: [] } as PairAssets
    },
  }
  const run = async (label: string, prepare: () => Promise<Prepared>) => {
    if (options.failAt && label.includes(options.failAt)) return 'failed' as const
    await prepare()
    return 'confirmed' as const
  }
  return { api, run, calls, balances }
}

async function plan(rate?: Record<string, bigint>) {
  const [route] = await findRoutes(MON, BLOBY, pairsOf)
  const reviewRate = rate ?? { '0xw1': 4n, '0xb1': 2n }
  return quoteRoute(route, ONE, 100, async (request) => {
    const out = BigInt(request.amountIn) * reviewRate[request.pairId]
    return { tokenOut: '0x', amountOut: out.toString(), amountOutMinimum: (out * 99n / 100n).toString(), priceImpactBps: 10,
      tooMuchImpact: false, balance: '0', allowances: [], approved: true }
  })
}
const noWait = async () => undefined

describe('running a routed swap', () => {
  it('wraps, swaps, then sells exactly what the previous step returned', async () => {
    const { api, run, calls } = fakeChain()
    const steps: number[] = []
    const outcome = await runRoute({ quoted: await plan(), slippageBps: 100, api, run, onStep: (step) => steps.push(step),
      wait: noWait })
    expect(outcome).toEqual({ status: 'done' })
    expect(calls).toEqual([`wrap ${ONE}`, `swap 0xw1 ${ONE}`, `swap 0xb1 ${4n * ONE}`])
    expect(steps).toEqual([0, 1, 2])
  })

  it('approves what a step still needs before swapping', async () => {
    const { api, run, calls } = fakeChain({ approvalsNeeded: true })
    await runRoute({ quoted: await plan(), slippageBps: 100, api, run, onStep: () => undefined, wait: noWait })
    expect(calls).toEqual([`wrap ${ONE}`, `approve 0xw1 ${ONE}`, `swap 0xw1 ${ONE}`, `approve 0xb1 ${4n * ONE}`,
      `swap 0xb1 ${4n * ONE}`])
  })

  it('stops before a swap when the rest of the route would return less than was reviewed', async () => {
    const { api, run, calls } = fakeChain({ rate: { '0xw1': 4n, '0xb1': 1n } })
    expect(await runRoute({ quoted: await plan(), slippageBps: 100, api, run, onStep: () => undefined, wait: noWait }))
      .toMatchObject({ status: 'stopped', reason: 'price', step: 1, holding: WMON })
    expect(calls).toEqual([`wrap ${ONE}`])
  })

  it('stops before a later step when the price has moved below what was reviewed', async () => {
    // Reviewed at 4 xNVDA then 2 BLOBY each; by the second step the pool pays only 1.
    const { api, run, calls } = fakeChain({ laterRate: { '0xb1': 1n } })
    const outcome = await runRoute({ quoted: await plan(), slippageBps: 100, api, run, onStep: () => undefined, wait: noWait })
    expect(outcome).toMatchObject({ status: 'stopped', reason: 'price', step: 2, holding: XNVDA })
    expect(calls).toEqual([`wrap ${ONE}`, `swap 0xw1 ${ONE}`])
  })

  it('stops where a step fails, saying what the wallet now holds', async () => {
    const { api, run } = fakeChain({ failAt: 'xNVDA for BLOBY' })
    expect(await runRoute({ quoted: await plan(), slippageBps: 100, api, run, onStep: () => undefined, wait: noWait }))
      .toMatchObject({ status: 'stopped', reason: 'failed', step: 2, holding: XNVDA })
  })
})
