import { useEffect, useState } from 'react'
import { getAddress, zeroAddress, type Hex } from 'viem'
import { api, type ManagedWalletRecord } from '../../lib/api-client'
import type { RunIntent } from '../../lib/execute'
import type { PairToken, Prepared, WalletBalances } from '../../lib/explore-api'
import { formatAmount, formatToken, rawAmount } from '../../lib/format'
import { sendProblem, withdrawable } from '../../lib/wallet'
import { button, input, secondary } from '../explore/ui'

type Props = {
  wallet: ManagedWalletRecord
  balances: WalletBalances
  ownerAddress?: string
  /** The asset to send, chosen here or from the balance list. */
  asset: string
  onAsset: (asset: string) => void
  busy: string
  run: RunIntent
}

const MON: PairToken = { address: zeroAddress, symbol: 'MON', decimals: 18 }
/** A fresh key per send, so a retried request finds the send it already started. */
const randomNonce = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)),
  (byte) => byte.toString(16).padStart(2, '0')).join('')}` as Hex

/** Sends MON or a held token from the managed wallet to any address, like any wallet's Send. */
export function WithdrawForm({ wallet, balances, ownerAddress, asset, onAsset, busy, run }: Props) {
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  useEffect(() => { setAmount('') }, [asset])

  const choices: PairToken[] = [MON, ...balances.tokens]
  const token = choices.find((choice) => choice.address.toLowerCase() === asset.toLowerCase()) ?? MON
  const available = withdrawable(balances, token.address)
  const toOwner = Boolean(ownerAddress) && recipient.toLowerCase() === ownerAddress?.toLowerCase()

  const prepare = async (): Promise<Prepared> => {
    const raw = rawAmount(amount, token.decimals)
    const problem = sendProblem({ wallet: wallet.address, recipient, amount: raw, available })
    if (problem) throw new Error(problem)
    return api.prepareMonadWithdrawal({ asset: token.address, recipient: getAddress(recipient),
      amount: raw.toString(), nonce: randomNonce() })
  }

  return <section aria-labelledby="withdraw-heading" className="rounded-2xl border border-line bg-field p-4">
    <h3 id="withdraw-heading" className="font-semibold">Send</h3>
    <div className="mt-3 grid gap-3">
      <label className="text-sm">Asset<select className={`${input} mt-1`} value={token.address}
        onChange={(event) => onAsset(event.target.value)}>
        {choices.map((choice) => <option key={choice.address} value={choice.address}>{choice.symbol}</option>)}</select></label>
      <label className="text-sm">Amount
        <span className="mt-1 flex gap-2"><input className={input} inputMode="decimal" value={amount} placeholder="0.0"
          onChange={(event) => setAmount(event.target.value.replace(',', '.'))} />
          {/* Max is exact, so nothing is left behind. */}
          <button type="button" className={`${secondary} px-4`} disabled={available <= 0n}
            onClick={() => setAmount(formatAmount(available, token.decimals))}>Max</button></span>
        <span className="mt-1 block text-xs text-ink-muted">Available {formatToken(available, token.decimals)} {token.symbol}
          {token.address === zeroAddress ? ' after keeping MON for the fee' : ''}</span></label>
      <label className="text-sm">To
        <span className="mt-1 flex gap-2"><input className={`${input} font-mono text-xs`} value={recipient}
          placeholder="0x…" spellCheck={false} autoComplete="off"
          onChange={(event) => setRecipient(event.target.value.trim())} />
          {ownerAddress && !toOwner ? <button type="button" className={`${secondary} shrink-0 px-3 text-sm`}
            onClick={() => setRecipient(ownerAddress)}>My wallet</button> : null}</span>
        {toOwner ? <span className="mt-1 block text-xs text-ink-muted">The wallet you signed in with.</span> : null}</label>
    </div>
    <button type="button" className={`${button} mt-4 w-full`}
      disabled={Boolean(busy) || !amount || !recipient || available <= 0n}
      onClick={() => void run('Send', async () => { const prepared = await prepare(); setAmount(''); return prepared })}>
      Send</button>
  </section>
}
