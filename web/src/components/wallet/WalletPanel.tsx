import { Loader } from '../Loader'
import { useCallback, useEffect, useState } from 'react'
import { zeroAddress } from 'viem'
import type { ManagedWalletRecord } from '../../lib/api-client'
import { useIntentRunner, type Notify } from '../../lib/execute'
import { exploreApi, type WalletBalances } from '../../lib/explore-api'
import { errorText, formatToken } from '../../lib/format'
import { formatUsd } from '../../lib/positions'
import { button, secondary } from '../explore/ui'
import { WithdrawForm } from './WithdrawForm'

type Props = {
  wallet: ManagedWalletRecord | null
  canProvision: boolean
  ownerAddress?: string
  onProvision: () => Promise<void>
  onRefreshWallet: () => Promise<void>
  onNotify: Notify
  /** Opens Swap on a held token. */
  onSwapToken: (token: string) => void
  onSignOut: () => void
}

const EXPLORER = 'https://monadscan.com'

/** The managed wallet in one place: its address for funding, what it holds, and withdrawals. */
export function WalletPanel({ wallet, canProvision, ownerAddress, onProvision, onRefreshWallet, onNotify, onSwapToken,
  onSignOut }: Props) {
  const [balances, setBalances] = useState<WalletBalances | null>(null)
  const [error, setError] = useState('')
  const [asset, setAsset] = useState<string>(zeroAddress)

  const load = useCallback(async (rethrow = false) => {
    if (!wallet) return
    try { setBalances(await exploreApi.getWalletBalances()); setError('') }
    catch (reason) { setError(errorText(reason)); if (rethrow) throw reason }
  }, [wallet])
  const settled = useCallback(async () => { await Promise.all([load(true), onRefreshWallet()]) }, [load, onRefreshWallet])
  const { busy, run } = useIntentRunner(onNotify, settled)
  useEffect(() => { void load() }, [load])

  if (!wallet) {
    return <div className="flex flex-col gap-4">
      <p className="text-ink-muted">{canProvision
        ? 'Tideweave adds liquidity from a managed wallet that only you can withdraw from. Create it to get started.'
        : 'Sign in with your owner wallet first.'}</p>
      {canProvision ? <button type="button" className={button} onClick={() => void onProvision()}>Create wallet</button> : null}
      <SignedIn ownerAddress={ownerAddress} onSignOut={onSignOut} />
    </div>
  }

  const reserve = balances ? BigInt(balances.reserve) : 0n
  return <div className="flex flex-col gap-5">
    <section aria-label="Address" className="rounded-2xl border border-line bg-field p-4">
      <p className="text-xs text-ink-muted">Address on Monad · {wallet.state}</p>
      <p className="mt-1 break-all font-mono text-sm">{wallet.address}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={secondary} onClick={() => void navigator.clipboard.writeText(wallet.address)
          .then(() => onNotify('success', 'Address copied'))}>Copy address</button>
        <a className={secondary} href={`${EXPLORER}/address/${wallet.address}`} target="_blank" rel="noreferrer">Explorer ↗</a>
      </div>
      <p className="mt-3 text-sm text-ink-muted">To fund it, send MON and tokens on Monad to this address. Keep a little MON for fees.</p>
    </section>

    <section aria-labelledby="holdings-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="holdings-heading" className="font-semibold">Holdings</h3>
        <button type="button" className="text-sm text-link underline-offset-4 hover:underline" onClick={() => void load()}>Refresh</button>
      </div>
      {error ? <p role="alert" className="mt-2 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm">{error}</p> : null}
      {!balances && !error ? <Loader label="Loading balances" /> : null}
      {balances ? <>
        <p className="mt-2 text-xs text-ink-muted">Estimated value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{formatUsd(balances.totalUsd)}</p>
        <p className="text-xs text-ink-muted">{balances.unpricedAssetCount > 0 ? `${balances.unpricedAssetCount} unpriced ${balances.unpricedAssetCount === 1 ? 'asset is' : 'assets are'} not counted. ` : ''}Liquidity in positions is on the Positions page.</p>
        <ul className="mt-3 divide-y divide-line rounded-2xl border border-line">
          {[{ address: zeroAddress, symbol: 'MON', decimals: 18, balance: balances.mon.balance, usd: balances.mon.usd },
            ...balances.tokens].map((token) => <li key={token.address}
            className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${asset === token.address ? 'bg-tint' : ''}`}>
            <span className="min-w-0"><span className="block font-medium">{token.symbol}</span>
              <span className="block text-sm tabular-nums">{formatToken(token.balance, token.decimals)}
                <span className="ml-2 text-xs text-ink-muted">{formatUsd(token.usd)}</span></span></span>
            <span className="flex gap-2">
              <button type="button" className={`${secondary} min-h-9 px-3 text-sm`} aria-label={`Swap ${token.symbol}`}
                onClick={() => onSwapToken(token.address)}>Swap</button>
              <button type="button" className={`${secondary} min-h-9 px-3 text-sm`} aria-label={`Send ${token.symbol}`}
                onClick={() => { setAsset(token.address); document.getElementById('withdraw-heading')?.scrollIntoView({ behavior: 'smooth' }) }}>
                Send</button>
            </span>
          </li>)}
        </ul>
        {reserve > 0n ? <div className="mt-3 rounded-xl border border-line bg-field p-3 text-sm">
          <p>Set up for nad.fun: Monad keeps {formatToken(reserve, 18)} MON in this wallet. Remove the setup to withdraw all of it; the next nad.fun deposit adds it again.</p>
          <button type="button" className={`${secondary} mt-3`} disabled={Boolean(busy)}
            onClick={() => void run('Remove nad.fun setup', () => exploreApi.prepareDelegationClear({
              idempotencyKey: crypto.randomUUID() }))}>Remove nad.fun setup</button>
        </div> : null}
      </> : null}
    </section>

    {balances ? <WithdrawForm wallet={wallet} balances={balances} ownerAddress={ownerAddress} asset={asset}
      onAsset={setAsset} busy={busy} run={run} /> : null}
    {busy ? <p role="status" className="text-sm text-link">{busy}…</p> : null}
    <SignedIn ownerAddress={ownerAddress} onSignOut={onSignOut} />
  </div>
}

/** Which owner wallet is signed in, and the way out: kept here rather than in the header. */
function SignedIn({ ownerAddress, onSignOut }: { ownerAddress?: string; onSignOut: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm text-ink-muted">
    <span>Signed in{ownerAddress ? <> as <span className="font-mono">{ownerAddress.slice(0, 6)}…{ownerAddress.slice(-4)}</span></> : null}</span>
    <button type="button" className={`${secondary} min-h-10 px-4 text-sm`} onClick={onSignOut}>Sign out</button>
  </div>
}
