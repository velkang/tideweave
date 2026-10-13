import { Loader } from '../components/Loader'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { ManagedWalletRecord } from '../lib/api-client'
import { exploreApi, type PairAssets, type PairDetail, type PairListItem, type PairToken, type Venue } from '../lib/explore-api'
import { useIntentRunner, type Notify } from '../lib/execute'
import { errorText, formatAmount, formatInput } from '../lib/format'
import { estimateSwapInput, roundUpAmount } from '../lib/swap-estimate'
import { DepositForm, type DepositSwapRequest } from '../components/explore/DepositForm'
import { PairList } from '../components/explore/PairList'
import { Sheet } from '../components/explore/Sheet'
import { SwapForm } from '../components/explore/SwapForm'
import { followLink, navigate, pairHref } from '../lib/route'
import { card, secondary } from '../components/explore/ui'
import { isMon, MON } from '../lib/swap-route'

type Props = {
  wallet: ManagedWalletRecord | null
  onRefreshWallet: () => Promise<void>
  onNotify: Notify
  /** A pair to open on arrival, from an /explore/<pool-id> link. */
  openPair?: { venue?: Venue; id: string } | null
}

/** A list row for a pair opened by link, so the list can highlight it. */
const listItem = (pair: PairDetail): PairListItem => ({ venue: pair.venue, id: pair.id, token0: pair.token0,
  token1: pair.token1, fee: pair.fee ?? null, tickSpacing: pair.tickSpacing ?? null, hooks: null,
  sqrtPriceX96: pair.sqrtPriceX96 ?? null, tick: pair.tick ?? null, liquidity: pair.liquidity ?? '0',
  reserve0: pair.reserve0 ?? null, reserve1: pair.reserve1 ?? null, memeToken: pair.memeToken ?? null, createdBlock: null })

/**
 * The swap opened from the deposit form: what it sells and gets (receive null: the user picks), a starting
 * amount, and why: to cover a shortfall, to bring holdings to the range's ratio, or any swap.
 */
type DepositSwap = { sell: PairToken; receive: PairToken | null; amount: string; reason: 'shortfall' | 'balance' | 'any' }

const heldOf = (assets: PairAssets | null, token: PairToken) => !assets ? 0n
  : isMon(token) ? BigInt(assets.monBalance)
    : BigInt((assets.token0.address.toLowerCase() === token.address.toLowerCase() ? assets.token0 : assets.token1).balance)

/** One screen for every pool type: find a pair, add both tokens, manage positions, withdraw. */
export function ExplorePage({ wallet, onRefreshWallet, onNotify, openPair }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<PairListItem | null>(null)
  const [pair, setPair] = useState<PairDetail | null>(null)
  const [pairError, setPairError] = useState('')
  const [assets, setAssets] = useState<PairAssets | null>(null)
  const [swap, setSwap] = useState<DepositSwap | null>(null)

  const refresh = useCallback(async () => {
    if (!wallet) return
    // The pair is read again too: a swap or deposit moves its price, which sets the deposit ratio.
    const [pairAssets, fresh] = await Promise.all([
      pair ? exploreApi.getPairAssets(pair.venue, pair.id) : Promise.resolve(null),
      pair ? exploreApi.getPair(pair.venue, pair.id).then((result) => result.pool).catch(() => null) : Promise.resolve(null),
    ])
    setAssets(pairAssets)
    if (fresh) setPair((current) => current && current.id === fresh.id ? fresh : current)
    await onRefreshWallet()
  }, [pair, wallet, onRefreshWallet])

  const { busy, run } = useIntentRunner(onNotify, refresh)

  useEffect(() => {
    if (!wallet) { setAssets(null); return }
    void refresh().catch((error) => onNotify('error', 'Wallet read failed', errorText(error)))
  }, [wallet?.address, pair?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const openSwap = ({ receiveIndex, needed = 0n, amountIn }: DepositSwapRequest) => {
    if (!pair) return
    if (receiveIndex === null) {
      setSwap({ sell: MON, receive: isMon(pair.token0) ? pair.token1 : pair.token0, amount: '', reason: 'any' }); return
    }
    const [wanted, other] = receiveIndex === 0 ? [pair.token0, pair.token1] : [pair.token1, pair.token0]
    if (amountIn !== undefined) {
      setSwap({ sell: other, receive: wanted, amount: formatInput(amountIn, other.decimals), reason: 'balance' }); return
    }
    // Sell the pool's other token when the wallet has enough of it; otherwise start from MON.
    const estimate = estimateSwapInput(pair, receiveIndex, needed)
    const rounded = estimate ? roundUpAmount(estimate, other.decimals) : null
    const useOther = isMon(wanted) || (rounded !== null && heldOf(assets, other) >= rounded)
    setSwap({ sell: useOther ? other : MON, receive: wanted, reason: 'shortfall',
      amount: useOther && rounded ? formatAmount(rounded, other.decimals) : '' })
  }

  // Scrolled to once the linked pair's panel has rendered.
  const [scrollToPair, setScrollToPair] = useState(false)
  useEffect(() => {
    if (!scrollToPair || !panelRef.current) return
    panelRef.current.scrollIntoView({ block: 'start' })
    setScrollToPair(false)
  }, [scrollToPair, pair])

  // A linked pair, such as "Add more" on a position, opens straight away.
  useEffect(() => {
    if (!openPair) { setSelected(null); setPair(null); setAssets(null); setPairError(''); return }
    let current = true
    setSwap(null); setSelected(null); setPair(null); setAssets(null); setPairError('')
    const request = openPair.venue ? exploreApi.getPair(openPair.venue, openPair.id) : exploreApi.getPairById(openPair.id)
    request.then(({ pool }) => {
      if (!current) return
      setSelected(listItem(pool)); setPair(pool); setScrollToPair(true)
    }).catch((error) => { if (current) setPairError(errorText(error)) })
    return () => { current = false }
  }, [openPair?.venue, openPair?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshButton = wallet ? <button type="button" className={`${secondary} min-h-11 px-3`} aria-label="Refresh balances and price"
    title="Refresh" onClick={() => void refresh().catch((error) => onNotify('error', 'Refresh failed', errorText(error)))}>
    <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" stroke="currentColor" strokeWidth="1.5" /></svg>
  </button> : null

  return <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-7 text-ink">
    {openPair ? <a href="/explore" onClick={followLink} className="inline-flex min-h-11 items-center gap-2 self-start text-sm text-link">
      <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" stroke="currentColor" strokeWidth="1.5" /></svg>
      All pools</a>
      : <div><h1 className="text-4xl font-semibold">Explore pools</h1>
        <p className="mt-2 max-w-[680px] text-ink-muted">Pick a pair to add liquidity and earn fees.</p></div>}

    {!openPair ? <section className="explore-directory" aria-label="Pools on Monad">
      <PairList selectedId={selected?.id ?? null} hrefForPair={item => pairHref(item.id)} onSelect={item => navigate(pairHref(item.id))} />
    </section> : <section className={card} aria-labelledby="pair-heading">
      {!pair && !pairError ? <Loader label="Loading pool" /> : null}
      {pairError ? <p role="alert" className="text-sm text-danger">This pool couldn't be loaded: {pairError}</p> : null}
      {pair ? <div ref={panelRef} className="scroll-mt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h1 id="pair-heading" className="text-3xl font-semibold">{pair.token0.symbol} / {pair.token1.symbol}</h1>
            <p className="mt-1 text-sm text-ink-muted">{feeLine(pair)}</p></div>
          {refreshButton}
        </div>
        {wallet ? <div className="mt-6"><DepositForm key={`${wallet.address}:${pair.venue}:${pair.id}`} pair={pair} assets={assets} walletActive={wallet.state === 'active'}
          busy={busy} run={run} onNotify={onNotify} onSwap={openSwap} /></div>
          : <p className="mt-6 text-ink-muted">Connect your wallet to add liquidity.</p>}
      </div> : null}
    </section>}

    <AnimatePresence>
      {swap && pair && wallet ? <Sheet key="deposit-swap" onClose={() => setSwap(null)}
        {...drawerText(swap)}>
        <SwapForm signedIn walletActive={wallet.state === 'active'} busy={busy} run={run}
          initialSell={swap.sell} initialReceive={swap.receive} initialAmount={swap.amount}
          suggested={[pair.token0, pair.token1]} onSwapped={() => setSwap(null)} />
      </Sheet> : null}
    </AnimatePresence>
    {busy ? <p role="status" className="text-sm text-link">{busy}…</p> : null}
  </div>
}

function drawerText(swap: DepositSwap) {
  if (swap.reason === 'any' || !swap.receive) return { title: 'Swap', description: '' }
  if (swap.reason === 'balance') {
    return { title: 'Even out your tokens', description: `Swap part of your ${swap.sell.symbol} for ${swap.receive.symbol} so you can add nearly all of it.` }
  }
  return { title: `Get ${swap.receive.symbol}`, description: swap.amount
    ? `The amount covers what you're short. Check the quote before swapping.` : '' }
}

/** What a deposit earns, in one line: "Earns 1% of every trade". */
function feeLine(pair: PairDetail) {
  if (pair.venue === 'nadfun-v2') return 'Earns 0.25% of every trade'
  if (pair.fee === 0x800000) return 'Earns a share of every trade; the fee changes with the market'
  return `Earns ${(pair.fee ?? 0) / 10_000}% of every trade`
}
