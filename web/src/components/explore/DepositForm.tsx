import { useEffect, useState } from 'react'
import { MONAD_DELEGATED_RESERVE, MONAD_TOKENS } from '@tideweave/chain'
import { zeroAddress } from 'viem'
import { balancingSwap, customTicks, quickAmountsReady, GAS_BUFFER, maxDeposit, pairedAmount, presetTicks, quoteFirst, spendableBalances } from '../../lib/deposit-math'
import { retryWhileCatchingUp, type DepositPlan } from '../../lib/deposit-flow'
import { useTransactions } from '../../lib/execute'
import type { Notify, RunIntent } from '../../lib/execute'
import type { PairAssets, PairDetail } from '../../lib/explore-api'
import { formatAmount, formatInput, rawAmount } from '../../lib/format'
import { VENUES, type Step } from '../../lib/venues'
import { AmountField } from './AmountField'
import { DepositReview } from './DepositReview'
import { CustomRange, RangePicker, rangeText, type RangeChoice } from './RangePicker'
import { button, input, secondary } from './ui'

/** A swap the deposit form asks for: the token to get (null: either way), and the shortfall or the amount to sell. */
export type DepositSwapRequest = { receiveIndex: 0 | 1 | null; needed?: bigint; amountIn?: bigint }

type Props = {
  pair: PairDetail
  assets: PairAssets | null
  walletActive: boolean
  busy: string
  run: RunIntent
  onNotify: Notify
  onSwap: (request: DepositSwapRequest) => void
}

/** The transactions a reviewed deposit runs, frozen at review, and how many have confirmed. */
const PERCENTS = [25, 50, 75, 100]
const panel = 'rounded-xl border border-line bg-field p-4 sm:p-5'
const parse = (text: string, decimals: number) => { try { return text ? rawAmount(text, decimals) : 0n } catch { return 0n } }
const isWmon = (address: string) => address.toLowerCase() === MONAD_TOKENS.WMON.toLowerCase()

/** Adds both tokens to the selected pair, whichever venue it is on: choose a range, type one amount, review, confirm. */
export function DepositForm({ pair, assets, walletActive, busy, run, onNotify, onSwap }: Props) {
  const { controller, attempt } = useTransactions()
  const planKey = `${pair.venue}:${pair.id}`
  const draft = controller.depositPlans.get(planKey)
  const adapter = VENUES[pair.venue]
  const tokens = [pair.token0, pair.token1] as const
  const [choice, setChoice] = useState<RangeChoice>('balanced')
  const [custom, setCustom] = useState({ min: '', max: '' })
  const [inverted, setInverted] = useState(() => draft?.inverted ?? quoteFirst(pair))
  const [texts, setTexts] = useState<[string, string]>(() => draft
    ? [formatInput(draft.amounts[0], pair.token0.decimals), formatInput(draft.amounts[1], pair.token1.decimals)] : ['', ''])
  const [edited, setEdited] = useState<0 | 1>(0)
  const [slippage, setSlippage] = useState(draft?.slippage ?? '1')
  const [plan, setPlanState] = useState<DepositPlan | null>(draft ?? null)
  const setPlan = (next: DepositPlan | null) => {
    if (next) controller.depositPlans.set(planKey, next)
    else controller.depositPlans.delete(planKey)
    setPlanState(next)
  }
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!plan?.pendingIntentId || busy) return
    if (attempt?.intentId !== plan.pendingIntentId) {
      setPlan({ ...plan, pendingIntentId: undefined })
      return
    }
    if (attempt.status === 'submitted') return
    if (attempt.status === 'confirmed' && plan.done + 1 === plan.steps.length) {
      setPlan(null); setTexts(['', ''])
      onNotify('success', 'Liquidity added', 'See it on the Positions tab.')
    } else setPlan({ ...plan, done: plan.done + (attempt.status === 'confirmed' ? 1 : 0), pendingIntentId: undefined })
  }, [plan?.pendingIntentId, attempt?.intentId, attempt?.status, busy]) // eslint-disable-line react-hooks/exhaustive-deps

  const ticks = !adapter.usesRange ? null
    : choice === 'custom' ? customTicks(pair, custom.min, custom.max, inverted) : presetTicks(pair, choice)
  const ticksKey = ticks ? `${ticks.tickLower}:${ticks.tickUpper}` : 'none'

  /** Both fields after typing `text` into field `index`: the other side follows the range's ratio. */
  const filled = (index: 0 | 1, text: string): [string, string] => {
    const amount = parse(text, tokens[index].decimals)
    const other = amount > 0n ? pairedAmount(pair, ticks, index, amount) : null
    const otherText = other === null ? '' : formatInput(other, tokens[index === 0 ? 1 : 0].decimals)
    return index === 0 ? [text, otherText] : [otherText, text]
  }
  // A new range changes the ratio: keep what was typed and fill the other side again. A reviewed deposit keeps
  // its amounts, even when a refresh moves the price.
  useEffect(() => {
    if (!plan) setTexts((current) => filled(edited, current[edited]))
  }, [ticksKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const editing = !plan && !running
  const type = (index: 0 | 1) => (text: string) => { setEdited(index); setTexts(filled(index, text)) }
  const desired: [bigint, bigint] = [parse(texts[0], pair.token0.decimals), parse(texts[1], pair.token1.decimals)]
  const spend = assets ? spendableBalances(pair, assets) : null
  const missing = desired.map((amount, index) => spend ? amount - spend.amounts[index] : 0n) as [bigint, bigint]
  const wmonIndex = pair.venue === 'nadfun-v2' ? tokens.findIndex((token) => isWmon(token.address)) : -1
  const wrapAmount = assets && wmonIndex >= 0 ? (() => {
    const shortfall = desired[wmonIndex] - BigInt((wmonIndex === 0 ? assets.token0 : assets.token1).balance)
    return shortfall > 0n ? shortfall : 0n
  })() : 0n
  const slippageBps = Math.round(Number(slippage) * 100)
  const slippageValid = slippage.trim() !== '' && Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 500
  const nadNeedsMon = pair.venue === 'nadfun-v2' && assets !== null &&
    BigInt(assets.monBalance) < MONAD_DELEGATED_RESERVE + GAS_BUFFER

  const max = spend ? maxDeposit(pair, ticks, spend.amounts) : null
  const usePercent = (percent: number) => {
    if (!max) return
    setEdited(0)
    setTexts([formatInput(max[0] * BigInt(percent) / 100n, pair.token0.decimals),
      formatInput(max[1] * BigInt(percent) / 100n, pair.token1.decimals)])
  }
  // Balance what can be added (counting MON a nad.fun deposit wraps), but sell no more than the wallet holds of
  // the sold token: a swap can't sell MON the deposit would wrap.
  const balancing = (() => {
    if (!assets || !spend || (adapter.usesRange && !ticks)) return null
    const swap = balancingSwap(pair, ticks, spend.amounts)
    if (!swap) return null
    const soldIndex = swap.receiveIndex === 0 ? 1 : 0
    const sold = soldIndex === 0 ? assets.token0 : assets.token1
    const sellable = sold.address === zeroAddress ? spend.amounts[soldIndex] : BigInt(sold.balance)
    const amountIn = swap.amountIn < sellable ? swap.amountIn : sellable
    return amountIn > 0n ? { ...swap, amountIn } : null
  })()

  const blocker = !assets ? 'Reading balances…'
    : adapter.usesRange && !ticks ? 'Choose a price range'
      : desired[0] <= 0n || desired[1] <= 0n ? 'Enter an amount'
        : missing[0] > 0n ? `Not enough ${pair.token0.symbol}`
          : missing[1] > 0n ? `Not enough ${pair.token1.symbol}`
            : nadNeedsMon ? 'Add MON first'
              : !slippageValid ? 'Fix the slippage limit' : ''

  const review = () => {
    if (!assets || blocker) return
    const amounts = desired
    const frozenTicks = ticks
    const deposit: Step = { label: 'Add liquidity', prepare: () => retryWhileCatchingUp(() => adapter.prepareDeposit({
      pair, amount0: amounts[0], amount1: amounts[1], slippageBps, wrapAmount, ...(frozenTicks ?? {}) })) }
    const approvals = adapter.approvalSteps(assets, amounts).map((step) =>
      ({ ...step, prepare: () => retryWhileCatchingUp(step.prepare) }))
    setPlan({ steps: [...approvals, deposit], done: 0, amounts, wrapAmount, ticks: frozenTicks, slippage, inverted })
  }

  const confirm = async () => {
    if (!plan || busy || plan.pendingIntentId) return
    setRunning(true)
    try {
      for (let index = plan.done; index < plan.steps.length; index += 1) {
        const result = await run(plan.steps[index].label, plan.steps[index].prepare)
        if (result !== 'confirmed') {
          if (result === 'pending') {
            onNotify('info', `${plan.steps[index].label} is still pending`, 'Check its status before continuing.')
            setPlan({ ...plan, done: index, pendingIntentId: controller.executingIntentId || undefined })
          } else setPlan({ ...plan, done: index })
          return
        }
        setPlan({ ...plan, done: index + 1 })
      }
      onNotify('success', 'Liquidity added', 'See it on the Positions tab.')
      setPlan(null); setTexts(['', ''])
    } finally { setRunning(false) }
  }

  const notes = [
    ...(pair.venue === 'nadfun-v2' ? ['Keeps 10 MON in your wallet while it is set up for nad.fun.'] : []),
  ]
  const held = spend ? [spend.amounts[0] > 0n, spend.amounts[1] > 0n] as const : null
  const canUsePercent = quickAmountsReady(spend?.amounts ?? null, max)

  return <div className="flex flex-col gap-4">
    <section aria-labelledby="amount-heading" className={panel}>
      <h2 id="amount-heading" className="font-semibold">Amount</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">{([0, 1] as const).map((index) =>
        <AmountField key={tokens[index].address} id={`deposit-amount-${index}`} token={tokens[index]} value={texts[index]}
          onChange={type(index)} spendable={spend ? spend.amounts[index] : null} missing={missing[index]} disabled={!editing}
          spendableNote={index === wmonIndex && spend && spend.wrapLimit > 0n ? `Includes ${formatAmount(spend.wrapLimit, 18)} MON` : undefined}
          onSwap={() => onSwap({ receiveIndex: index, needed: missing[index] > 0n ? missing[index] : 0n })} />)}
      </div>
      {editing && held ? <AmountHelp pair={pair} held={held} canUsePercent={canUsePercent} balancing={balancing}
        busy={Boolean(busy)} onPercent={usePercent} onSwap={onSwap} /> : null}
      {nadNeedsMon ? <p role="alert" className="mt-3 text-sm text-danger">
        Needs at least {formatAmount(MONAD_DELEGATED_RESERVE + GAS_BUFFER, 18)} MON in your wallet for nad.fun.</p> : null}
    </section>

    {adapter.usesRange ? <div className={panel}><RangePicker pair={pair} choice={choice} onChoice={setChoice} inverted={inverted}
      ticks={ticks} disabled={!editing} /></div>
      : <p className="px-1 text-sm text-ink-muted">This pair has no price range: it earns at every price.</p>}

    <details className={`${panel} group`}>
      <summary className="min-h-11 cursor-pointer list-none py-2 font-medium marker:hidden">More options</summary>
      <div className="mt-2 flex flex-col gap-5">
        {adapter.usesRange ? <div>
          <h3 className="mb-2 text-sm font-semibold">Your own price range</h3>
          <CustomRange pair={pair} custom={custom} inverted={inverted} disabled={!editing}
            invalid={choice === 'custom' && !ticks && Boolean(custom.min.trim() && custom.max.trim())}
            onCustom={(next) => { setCustom(next); setChoice('custom') }}
            onFlip={() => { setInverted(!inverted); setCustom({ min: '', max: '' }) }} />
        </div> : null}
        <label className="block max-w-[240px] text-sm font-semibold">Max price change (%)
          <input className={`${input} mt-1 font-normal`} inputMode="decimal" value={slippage} disabled={!editing}
            onChange={(event) => setSlippage(event.target.value)} />
          <span className="mt-1 block text-xs font-normal text-ink-muted">If the price moves more before it confirms, nothing is added.</span></label>
        <button type="button" className={`${secondary} self-start`} disabled={Boolean(busy) || !assets || !walletActive}
          onClick={() => onSwap({ receiveIndex: null })}>Swap tokens</button>
      </div>
    </details>

    {plan ? <DepositReview pair={pair} amounts={plan.amounts} wrapAmount={plan.wrapAmount} slippage={slippage}
      range={plan.ticks ? rangeText(pair, plan.ticks, inverted) : null} notes={notes}
      steps={plan.steps.map((step) => step.label)} done={plan.done} running={running}
      disabled={Boolean(busy) || Boolean(plan.pendingIntentId)}
      onConfirm={() => void confirm()} onEdit={() => setPlan(null)} />
      : <button type="button" className={`${button} w-full sm:w-auto sm:self-start`}
        disabled={Boolean(blocker) || Boolean(busy) || !walletActive} onClick={review}>{blocker || 'Review deposit'}</button>}
  </div>
}

type Balancing = { receiveIndex: 0 | 1; amountIn: bigint } | null

/**
 * The one hint the amounts need now: tokens to get when the wallet lacks one or both, a swap to even out uneven
 * holdings, or quick amounts once both are held. Nothing shows that can't be used yet.
 */
function AmountHelp({ pair, held, canUsePercent, balancing, busy, onPercent, onSwap }: { pair: PairDetail;
  held: readonly [boolean, boolean]; canUsePercent: boolean; balancing: Balancing; busy: boolean;
  onPercent: (percent: number) => void; onSwap: (request: DepositSwapRequest) => void }) {
  const tokens = [pair.token0, pair.token1] as const
  const missing = ([0, 1] as const).filter((index) => !held[index])
  if (missing.length > 0) {
    const names = missing.map((index) => tokens[index].symbol).join(' and ')
    return <div className="mt-4 flex flex-col gap-3 rounded-xl border border-line bg-card p-3 text-sm sm:flex-row sm:items-center">
      <span className="min-w-0 sm:flex-1">You need {names} to add liquidity.</span>
      <span className="flex flex-wrap gap-2">{missing.map((index) => <button key={index} type="button" className={`${button} min-h-10 px-4 text-sm`} disabled={busy}
        // Holding the other token, get this one by swapping part of it; holding neither, the swap starts from MON.
        onClick={() => onSwap(balancing?.receiveIndex === index ? { receiveIndex: index, amountIn: balancing.amountIn }
          : { receiveIndex: index, needed: 0n })}>Get {tokens[index].symbol}</button>)}</span>
    </div>
  }
  return <div className="mt-4 flex flex-col gap-3">
    {canUsePercent ? <div className="grid max-w-[420px] grid-cols-4 gap-2" role="group" aria-label="Use part of what you hold">
      {PERCENTS.map((percent) => <button key={percent} type="button" className={`${secondary} min-h-10 px-2`} disabled={busy}
        onClick={() => onPercent(percent)}>{percent === 100 ? 'Max' : `${percent}%`}</button>)}
    </div> : null}
    {balancing ? <p className="text-sm text-ink-muted">Your tokens are uneven for this range.{' '}
      <button type="button" className="font-medium text-link underline-offset-4 hover:underline" disabled={busy}
        onClick={() => onSwap({ receiveIndex: balancing.receiveIndex, amountIn: balancing.amountIn })}>
        Swap some {tokens[balancing.receiveIndex === 0 ? 1 : 0].symbol} for {tokens[balancing.receiveIndex].symbol}</button></p> : null}
  </div>
}
