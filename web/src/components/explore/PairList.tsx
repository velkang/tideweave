import { Loader } from '../Loader'
import { useEffect, useState } from 'react'
import { exploreApi, type PairListItem } from '../../lib/explore-api'
import { errorText, formatFee, pairPrice, short, VENUE_LABEL } from '../../lib/format'
import { followLink } from '../../lib/route'
import { input, secondary } from './ui'

type Props = {
  compact?: boolean
  hrefForPair?: (pair: PairListItem) => string
  selectedId: string | null
  onSelect: (pair: PairListItem) => void
  /** A search to start from, such as a token address from the wallet. */
  initialQuery?: string
  /** Told each first page of results, for a caller that acts on them, such as opening the only match. */
  onResults?: (pairs: PairListItem[]) => void
}

const SEARCH_DELAY_MS = 300

/** One list of every venue's pairs: browse newest first, or search by symbol, token or pool address. */
export function PairList({ selectedId, onSelect, initialQuery = '', onResults, hrefForPair, compact = false }: Props) {
  const [query, setQuery] = useState(initialQuery)
  useEffect(() => { setQuery(initialQuery) }, [initialQuery])
  const [pairs, setPairs] = useState<PairListItem[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    const timer = setTimeout(() => {
      exploreApi.listPairs(query.trim())
        .then((result) => {
          if (!active) return
          setPairs(result.pools); setNextOffset(result.nextOffset); setError(''); onResults?.(result.pools)
        })
        .catch((reason) => { if (active) setError(errorText(reason)) })
        .finally(() => { if (active) setLoading(false) })
    }, SEARCH_DELAY_MS)
    return () => { active = false; clearTimeout(timer) }
  }, [query])

  const loadMore = async () => {
    if (nextOffset === null) return
    setLoading(true)
    try {
      const result = await exploreApi.listPairs(query.trim(), nextOffset)
      setPairs((current) => [...current, ...result.pools])
      setNextOffset(result.nextOffset)
    } catch (reason) { setError(errorText(reason)) }
    finally { setLoading(false) }
  }

  return <div className={compact ? 'pool-directory pool-directory-compact' : 'pool-directory'}>
    <div className="pool-search">
      <label className="relative block"><span className="sr-only">Search pairs</span>
        <svg className="pointer-events-none absolute left-3 top-3 size-5 text-ink-muted" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.5" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.5" /></svg>
        <input className={`${input} pl-10`} value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search token or pool address" /></label>
      {!compact ? <p>Uniswap v3 · Uniswap v4 · nad.fun</p> : null}
    </div>
    {error ? <p role="alert" className="mt-4 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm">{error}</p> : null}
    {!compact ? <div className="pool-columns" aria-hidden="true"><span>Pair / pool</span><span>Venue</span><span>Fee</span><span>Spot price</span><span /></div> : null}
    <div className="pool-rows" aria-busy={loading}>
      {pairs.map((pair) => {
        const selected = pair.id.toLowerCase() === selectedId?.toLowerCase()
        const row = <>
          <span className="pool-identity"><span className="pool-token-marks" aria-hidden="true"><span>{pair.token0.symbol.slice(0, 2)}</span><span>{pair.token1.symbol.slice(0, 2)}</span></span>
            <span className="min-w-0"><strong className="block break-words">{pair.token0.symbol} / {pair.token1.symbol}</strong><span className="font-mono text-xs text-ink-muted">{short(pair.id)}</span></span></span>
          <span className="pool-venue">{VENUE_LABEL[pair.venue]}</span>
          <span className="pool-fee">{formatFee(pair.fee)}<span className="sm:hidden"> fee</span></span>
          <span className="pool-price"><span className="text-xs text-ink-muted">1 {pair.token0.symbol} ≈ </span><span>{pairPrice(pair)} {pair.token1.symbol}</span></span>
          <svg className="pool-arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" /></svg>
        </>
        return hrefForPair ? <a key={`${pair.venue}:${pair.id}`} href={hrefForPair(pair)} onClick={followLink} className="pool-row">{row}</a>
          : <button type="button" key={`${pair.venue}:${pair.id}`} onClick={() => onSelect(pair)} aria-pressed={selected} className="pool-row">{row}</button>
      })}
    </div>
    {!loading && pairs.length === 0 && !error
      ? <p className="mt-4 text-sm text-ink-muted">No pairs found. Paste a token or pool address to look it up on Monad.</p> : null}
    {loading ? <Loader label="Loading pools" /> : null}
    {nextOffset !== null && !loading
      ? <button type="button" className={`${secondary} mt-4`} onClick={() => void loadMore()}>Load more</button> : null}
  </div>
}
