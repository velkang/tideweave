import { useEffect, useState } from 'react'
import type { ManagedWalletRecord } from '../lib/api-client'
import { exploreApi, type PairToken } from '../lib/explore-api'
import { useIntentRunner, type Notify } from '../lib/execute'
import { Loader } from '../components/Loader'
import { SwapForm } from '../components/explore/SwapForm'
import { MON, sameToken, tokensIn } from '../lib/swap-route'

type Props = {
  wallet: ManagedWalletRecord | null
  onRefreshWallet: () => Promise<void>
  onNotify: Notify
  onSignIn: () => void
  /** On /swap/<token>: the token to sell. */
  token: string | null
}

/** Reads a token's symbol and decimals from the pairs that hold it. */
async function lookUpToken(address: string): Promise<PairToken | null> {
  const { pools } = await exploreApi.listPairs(address)
  return tokensIn(pools).find((token) => sameToken(token.address, address)) ?? null
}

export function SwapPage({ wallet, onRefreshWallet, onNotify, onSignIn, token }: Props) {
  const { busy, run } = useIntentRunner(onNotify, onRefreshWallet)
  const [sell, setSell] = useState<PairToken | null>(token ? null : MON)

  useEffect(() => {
    if (!token) { setSell(MON); return }
    let active = true
    setSell(null)
    lookUpToken(token).then((found) => { if (active) setSell(found ?? MON) })
      .catch(() => { if (active) setSell(MON) })
    return () => { active = false }
  }, [token])

  return <div className="swap-page">
    <div className="swap-title"><h1>Swap</h1></div>
    <section className="swap-panel" aria-label="Token swap">
      {sell ? <SwapForm key={sell.address} signedIn={wallet !== null} walletActive={wallet?.state === 'active'}
        busy={busy} run={run} initialSell={sell} initialReceive={null} onSignIn={onSignIn} />
        : <Loader label="Loading token" />}
      {busy ? <p role="status" className="mt-3 text-sm text-link">{busy}…</p> : null}
    </section>
    <p className="swap-footnote">Tideweave checks every pool for the two tokens and uses the best price.</p>
  </div>
}
