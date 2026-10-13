import { useCallback, useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { exploreApi, type PairToken, type SwapQuote, type WalletBalances } from '../../lib/explore-api'
import type { RunIntent } from '../../lib/execute'
import { formatAmount, formatInput, formatPrice, formatToken, rawAmount } from '../../lib/format'
import { legLabel, runRoute } from '../../lib/route-run'
import { routeLabel } from '../../lib/routing'
import { heldAmount, sellable, withPairAssets } from '../../lib/swap-route'
import { StepList } from './StepList'
import { TokenPicker } from './TokenPicker'
import { useSwapRoute } from './useSwapRoute'
import { button } from './ui'

type Props = {
  signedIn: boolean
  walletActive: boolean
  busy: string
  run: RunIntent
  /** The token to sell first. */
  initialSell: PairToken
  /** The token to get first, or null to let the user choose. */
  initialReceive: PairToken | null
  /** A starting amount to sell, in whole units. */
  initialAmount?: string
  /** Tokens offered first in the picker, such as the pool being added to. */
  suggested?: readonly PairToken[]
  onSignIn?: () => void
  /** Called once a swap has confirmed. */
  onSwapped?: () => void
}

const PERCENTS = [25, 50, 75, 100]
const key = () => crypto.randomUUID()
// Permit2 approvals last a little under the API's three-day limit.
const permit2Expiry = () => String(Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60 - 600)
const parse = (text: string, decimals: number) => { try { return text ? rawAmount(text, decimals) : 0n } catch { return 0n } }

/** The first approval the quoted swap still needs, if any. */
function nextApproval(quote: SwapQuote, amount: bigint) {
  const soon = BigInt(Math.floor(Date.now() / 1000) + 900)
  return quote.allowances.find((item) => BigInt(item.allowance) < amount ||
    (item.stage === 'permit2' && BigInt(item.expiration ?? '0') <= soon)) ?? null
}

/** Sells an exact amount of any token (or MON) for another, in whichever pool pays the most. */
export function SwapForm({ signedIn, walletActive, busy, run, initialSell, initialReceive, initialAmount = '',
  suggested = [], onSignIn, onSwapped }: Props) {
  const [sell, setSell] = useState(initialSell)
  const [receive, setReceive] = useState<PairToken | null>(initialReceive)
  const [amount, setAmount] = useState(initialAmount)
  const [slippage, setSlippage] = useState('1')
  const [showSettings, setShowSettings] = useState(false)
  const [picking, setPicking] = useState<'sell' | 'receive' | null>(null)
  const [walletBalances, setWalletBalances] = useState<WalletBalances | null>(null)

  const amountIn = parse(amount, sell.decimals)
  const slippageBps = Math.round(Number(slippage) * 100)
  const { route, assets, best, quoting, error, requote, loadAssets } =
    useSwapRoute(sell, receive, amountIn, slippageBps, signedIn)

  const loadBalances = useCallback(async () => {
    if (!signedIn) { setWalletBalances(null); return }
    try { setWalletBalances(await exploreApi.getWalletBalances()) } catch { setWalletBalances(null) }
  }, [signedIn])
  useEffect(() => { void loadBalances() }, [loadBalances])

  const balances = walletBalances ? withPairAssets(walletBalances, assets) : null
  const held = heldAmount(sell, balances)
  const spendable = sellable(sell, balances)
  const short = spendable !== null && amountIn > spendable
  // One swap in one pool runs as before: approve, then swap. Anything longer (a wrap, or a token in between) runs
  // as a checklist of steps behind one Swap button.
  const onlyLeg = best && best.route.legs.length === 1 && best.route.legs[0].kind === 'swap' ? best.route.legs[0] : null
  const quote = best ? { amountOut: best.amountOut.toString(), amountOutMinimum: best.minimumOut.toString(),
    priceImpactBps: best.priceImpactBps, tooMuchImpact: best.tooMuchImpact } : null
  const approval = onlyLeg && best ? nextApproval(best.swapQuotes[0], amountIn) : null
  const multiStep = best !== null && onlyLeg === null
  const [progress, setProgress] = useState<{ steps: string[]; done: number } | null>(null)
  const [stopped, setStopped] = useState('')

  const usePercent = (percent: number) => {
    if (spendable === null || spendable <= 0n) return
    // Max is exact; a share rounds down so it never asks for more than is there.
    setAmount(percent === 100 ? formatAmount(spendable, sell.decimals)
      : formatInput(spendable * BigInt(percent) / 100n, sell.decimals))
  }
  const pick = (token: PairToken) => {
    if (picking === 'sell') { setSell(token); setAmount('') } else setReceive(token)
    setPicking(null)
  }
  const flip = () => { if (!receive) return; setSell(receive); setReceive(sell); setAmount('') }

  const approve = async () => {
    if (!approval || !onlyLeg) return
    await run(`Approve ${sell.symbol}`, () => exploreApi.prepareSwapApproval({ venue: onlyLeg.pool.venue, pairId: onlyLeg.pool.id,
      tokenAddress: sell.address, stage: approval.stage, amount: amountIn.toString(),
      ...(approval.stage === 'permit2' ? { expiration: permit2Expiry() } : {}), idempotencyKey: key() }))
    await Promise.all([requote(), loadAssets()])
  }
  const swap = async () => {
    if (!best) return
    setStopped('')
    if (multiStep) { await swapSteps(); return }
    if (!onlyLeg) return
    const result = await run('Swap', () => exploreApi.prepareSwap({ venue: onlyLeg.pool.venue, pairId: onlyLeg.pool.id,
      tokenIn: sell.address, amountIn: amountIn.toString(), slippageBps, idempotencyKey: key() }))
    setAmount('')
    await Promise.all([loadBalances(), loadAssets()])
    if (result === 'confirmed') onSwapped?.()
  }
  const swapSteps = async () => {
    if (!best) return
    const steps = best.route.legs.map(legLabel)
    setProgress({ steps, done: 0 })
    const outcome = await runRoute({ quoted: best, slippageBps, api: exploreApi, run,
      onStep: (index) => setProgress({ steps, done: index }) })
    setProgress(null)
    await Promise.all([loadBalances(), loadAssets()])
    if (outcome.status === 'done') { setAmount(''); onSwapped?.(); return }
    const where = `Your ${outcome.holding.symbol} is in your wallet.`
    setStopped(outcome.reason === 'price' ? `The price moved too far between steps, so the swap stopped. ${where}`
      : outcome.reason === 'pending' ? `A step is still waiting to confirm. Check it before swapping again. ${where}`
        : `A step didn't go through. ${where}`)
  }


  if (picking) {
    return <TokenPicker title={picking === 'sell' ? 'You sell' : 'You get'} balances={balances} suggested={suggested}
      exclude={picking === 'sell' ? receive : sell} onPick={pick} onCancel={() => setPicking(null)} />
  }

  const action = progress ? { label: 'Swapping…', disabled: true }
    : !signedIn ? { label: 'Connect wallet', onClick: onSignIn, disabled: !onSignIn }
    : !receive ? { label: 'Choose a token to get', onClick: () => setPicking('receive'), disabled: false }
      : route.status === 'finding' ? { label: 'Finding a pool…', disabled: true }
        : route.status !== 'ready' ? { label: 'Swap', disabled: true }
          : amountIn <= 0n ? { label: 'Enter an amount', disabled: true }
            : short ? { label: `Not enough ${sell.symbol}`, disabled: true }
              : !quote ? { label: quoting ? 'Getting the best price…' : 'Swap', disabled: true }
                : approval ? { label: `Allow ${sell.symbol}${approval.stage === 'permit2' ? ' (step 2)' : ''}`, onClick: () => void approve(),
                  disabled: Boolean(busy) || !walletActive }
                  : { label: multiStep && best ? `Swap · ${best.route.legs.length} steps` : 'Swap', onClick: () => void swap(),
                    disabled: Boolean(busy) || !walletActive || quote.tooMuchImpact }
  const rate = quote && receive && amountIn > 0n
    ? Number(formatUnits(BigInt(quote.amountOut), receive.decimals)) / Number(formatUnits(amountIn, sell.decimals)) : null

  return <section aria-label="Swap" className="swap-form">
    <div className="swap-amount-block">
      <div className="flex items-center justify-between gap-3"><label htmlFor="swap-amount" className="text-sm text-ink-muted">You sell</label>
        <TokenButton token={sell} onClick={() => setPicking('sell')} disabled={Boolean(busy)} /></div>
      <input id="swap-amount" className="swap-amount-input" inputMode="decimal" autoComplete="off" value={amount} placeholder="0"
        onChange={(event) => setAmount(event.target.value.replace(',', '.'))} />
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3">
        <span className="text-xs text-ink-muted tabular-nums">{held === null ? '' : `Balance ${formatToken(held, sell.decimals)}`}</span>
        {spendable !== null && spendable > 0n ? <span className="flex gap-1" role="group" aria-label={`Sell part of your ${sell.symbol}`}>
          {PERCENTS.map((percent) => <button key={percent} type="button" className="swap-percent"
            disabled={Boolean(busy)} onClick={() => usePercent(percent)}>{percent === 100 ? 'Max' : `${percent}%`}</button>)}
        </span> : null}
      </div>
    </div>
    <div className="swap-direction"><button type="button" aria-label="Swap direction" disabled={Boolean(busy) || !receive} onClick={flip}>
      <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button></div>
    <div className="swap-amount-block">
      <div className="flex items-center justify-between gap-3"><span className="text-sm text-ink-muted">You get</span>
        <TokenButton token={receive} onClick={() => setPicking('receive')} disabled={Boolean(busy)} /></div>
      <p className="swap-output tabular-nums">{quote && receive ? formatToken(quote.amountOut, receive.decimals) : '0'}</p>
      <span className="text-xs text-ink-muted">{quote && receive ? `${multiStep ? 'Expected at least' : 'At least'} ${formatToken(quote.amountOutMinimum, receive.decimals)} ${receive.symbol}` : ' '}</span>
    </div>

    {route.status === 'none' && receive ? <NoPool sell={sell} receive={receive} alternatives={route.alternatives}
      onUse={(token) => { setSell(token); setAmount('') }} /> : null}
    {route.status === 'error' ? <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm">{route.message}</p> : null}
    {error ? <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm">{error}</p> : null}
    {quote?.tooMuchImpact ? <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm">This pool is too small for that amount. Try a smaller one.</p> : null}

    {multiStep && best && !progress ? <p className="px-1 text-xs text-ink-muted">Route: {routeLabel(best.route)}. Runs
      as {best.route.legs.length} steps, and stops if the price moves too far between them.</p> : null}
    {progress ? <div className="rounded-lg border border-line bg-field p-3"><StepList steps={progress.steps} done={progress.done} running /></div> : null}
    {stopped ? <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm">{stopped}</p> : null}

    {rate && receive ? <div className="flex flex-wrap justify-between gap-2 px-1 text-xs text-ink-muted">
      <span>1 {sell.symbol} ≈ {formatPrice(rate)} {receive.symbol}</span>
      {quote && quote.priceImpactBps >= 100 ? <span>Price impact {(quote.priceImpactBps / 100).toFixed(1)}%</span> : null}
    </div> : null}

    <button type="button" className={`${button} w-full`} disabled={action.disabled} onClick={action.onClick}>{action.label}</button>
    {approval ? <p className="text-center text-xs text-ink-muted">One-time permission for the pool to take your {sell.symbol}. Then swap.</p> : null}

    <div className="swap-settings">
      <button type="button" className="min-h-11 underline-offset-4 hover:underline" aria-expanded={showSettings}
        onClick={() => setShowSettings(!showSettings)}>Max price change: {slippage || '?'}%</button>
      {showSettings ? <span className="flex items-center gap-1"><input aria-label="Max price change (%)" className="swap-slippage"
        inputMode="decimal" value={slippage} onChange={(event) => setSlippage(event.target.value)} /><span>%</span></span> : null}
    </div>
  </section>
}

function TokenButton({ token, onClick, disabled }: { token: PairToken | null; onClick: () => void; disabled: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled}
    className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line-strong px-3 font-semibold hover:bg-tint disabled:opacity-50">
    {token ? token.symbol : <span className="text-link">Choose token</span>}
    <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.5" /></svg>
  </button>
}

/** No pool links the two tokens: say so, and offer the tokens the wanted one does trade with. */
function NoPool({ sell, receive, alternatives, onUse }: { sell: PairToken; receive: PairToken;
  alternatives: PairToken[]; onUse: (token: PairToken) => void }) {
  const options = alternatives.filter((token) => token.address.toLowerCase() !== sell.address.toLowerCase()).slice(0, 4)
  return <div className="rounded-lg border border-line bg-field p-3 text-sm">
    <p>No pool swaps {sell.symbol} for {receive.symbol} directly.</p>
    {options.length > 0 ? <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-ink-muted">Sell instead:</span>
      {options.map((token) => <button key={token.address} type="button" onClick={() => onUse(token)}
        className="min-h-9 rounded-full border border-line-strong px-3 font-medium hover:bg-tint">{token.symbol}</button>)}
    </div> : null}
  </div>
}
