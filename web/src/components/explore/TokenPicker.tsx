import { useEffect, useState } from 'react'
import { isAddress } from 'viem'
import { exploreApi, type PairToken, type WalletBalances } from '../../lib/explore-api'
import { errorText, formatToken, short } from '../../lib/format'
import { heldAmount, isMon, MON, sameToken, tokensIn } from '../../lib/swap-route'
import { input, secondary } from './ui'

type Props = {
  title: string
  balances: WalletBalances | null
  /** Tokens to offer first, such as the pool the user is adding to. */
  suggested?: readonly PairToken[]
  /** The token on the other side, which can't be picked again. */
  exclude: PairToken | null
  onPick: (token: PairToken) => void
  onCancel: () => void
}

const SEARCH_DELAY_MS = 300

/** Picks a token: MON, what the wallet holds, suggestions, or any token found by symbol or address. */
export function TokenPicker({ title, balances, suggested = [], exclude, onPick, onCancel }: Props) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<PairToken[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const text = query.trim()
    if (!text) { setFound([]); setError(''); return }
    let active = true
    setSearching(true)
    const timer = setTimeout(() => {
      exploreApi.listPairs(text).then(({ pools }) => {
        if (!active) return
        const lower = text.toLowerCase()
        setFound(tokensIn(pools).filter((token) => isAddress(text)
          ? sameToken(token.address, text) : token.symbol.toLowerCase().startsWith(lower)))
        setError('')
      }).catch((reason) => { if (active) setError(errorText(reason)) })
        .finally(() => { if (active) setSearching(false) })
    }, SEARCH_DELAY_MS)
    return () => { active = false; clearTimeout(timer) }
  }, [query])

  const held = (balances?.tokens ?? []).filter((token) => BigInt(token.balance) > 0n)
  const base = query.trim() ? found : [MON, ...suggested, ...held]
  const list = base.filter((token, index) => (!exclude || !sameToken(token.address, exclude.address)) &&
    base.findIndex((other) => sameToken(other.address, token.address)) === index)

  return <section aria-label={title} className="flex flex-col gap-3">
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-semibold">{title}</h3>
      <button type="button" className={`${secondary} px-4`} onClick={onCancel}>Back</button>
    </div>
    <label className="block"><span className="sr-only">Search tokens</span>
      <input autoFocus className={input} value={query} placeholder="Search name or paste address"
        onChange={(event) => setQuery(event.target.value)} /></label>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <ul className="flex flex-col" aria-busy={searching}>
      {list.map((token) => {
        const amount = heldAmount(token, balances)
        return <li key={token.address}><button type="button" onClick={() => onPick(token)}
          className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl px-3 text-left hover:bg-tint">
          <span className="min-w-0"><strong className="block">{token.symbol}</strong>
            <span className="font-mono text-xs text-ink-muted">{isMon(token) ? 'Monad' : short(token.address)}</span></span>
          {amount !== null && amount > 0n ? <span className="text-sm tabular-nums text-ink-muted">{formatToken(amount, token.decimals)}</span> : null}
        </button></li>
      })}
    </ul>
    {searching ? <p className="text-sm text-ink-muted">Searching…</p>
      : query.trim() && list.length === 0 && !error ? <p className="text-sm text-ink-muted">No token found. Paste its address to look it up.</p> : null}
  </section>
}
