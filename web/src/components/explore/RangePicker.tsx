import { currentPrice, displayPrice, presetTicks, RANGE_PRESETS, type RangePreset, type Ticks } from '../../lib/deposit-math'
import type { PairDetail } from '../../lib/explore-api'
import { formatPrice, plainPrice } from '../../lib/format'
import { input } from './ui'

export type RangeChoice = RangePreset | 'custom'

/** Whole-unit price bounds of a range, low to high in the shown direction. */
export function rangeBounds(pair: PairDetail, ticks: Ticks, inverted: boolean) {
  const prices = [displayPrice(pair, ticks.tickLower, inverted), displayPrice(pair, ticks.tickUpper, inverted)]
  return { low: Math.min(...prices), high: Math.max(...prices) }
}

const fullRange = (pair: PairDetail, ticks: Ticks) => ticks.tickLower === presetTicks(pair, 'full').tickLower &&
  ticks.tickUpper === presetTicks(pair, 'full').tickUpper

/** Describes a range in words: "while 1 WMON is between 0.027 and 0.033 USDC", or "at any price". */
export function rangeText(pair: PairDetail, ticks: Ticks, inverted: boolean) {
  if (fullRange(pair, ticks)) return 'at any price'
  const [base, quote] = inverted ? [pair.token1, pair.token0] : [pair.token0, pair.token1]
  const { low, high } = rangeBounds(pair, ticks, inverted)
  return `while 1 ${base.symbol} is between ${formatPrice(low)} and ${formatPrice(high)} ${quote.symbol}`
}

const segment = (selected: boolean) => `min-h-11 min-w-0 rounded-lg px-2 text-sm font-medium ${
  selected ? 'bg-card text-ink shadow-sm ring-1 ring-link' : 'text-ink-muted hover:text-ink'} disabled:cursor-not-allowed disabled:opacity-50`

type Props = {
  pair: PairDetail
  choice: RangeChoice
  onChoice: (choice: RangeChoice) => void
  inverted: boolean
  /** The chosen range, or null when custom prices don't make one yet. */
  ticks: Ticks | null
  disabled: boolean
}

/** Picks how far the price can move while the deposit earns: four presets, explained in one sentence. */
export function RangePicker({ pair, choice, onChoice, inverted, ticks, disabled }: Props) {
  const [base, quote] = inverted ? [pair.token1, pair.token0] : [pair.token0, pair.token1]
  const now = formatPrice(currentPrice(pair, inverted))
  return <section aria-labelledby="range-heading">
    <h2 id="range-heading" className="font-semibold">Price range</h2>
    <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-field p-1 sm:grid-cols-4" role="radiogroup" aria-label="Price range">
      {RANGE_PRESETS.map((entry) => <button key={entry.key} type="button" role="radio" aria-checked={choice === entry.key}
        disabled={disabled} className={segment(choice === entry.key)} onClick={() => onChoice(entry.key)}>{entry.name}</button>)}
    </div>
    <p className="mt-3 text-sm text-ink-muted">
      {ticks ? `Earns ${fullRange(pair, ticks) ? 'at any price' : `while 1 ${base.symbol} stays between ${formatPrice(rangeBounds(pair, ticks, inverted).low)} and ${formatPrice(rangeBounds(pair, ticks, inverted).high)} ${quote.symbol}`}. `
        : 'Set your lowest and highest price under More options. '}
      <span className="whitespace-nowrap">Now {now} {quote.symbol}.</span></p>
  </section>
}

type CustomProps = {
  pair: PairDetail
  custom: { min: string; max: string }
  onCustom: (custom: { min: string; max: string }) => void
  inverted: boolean
  onFlip: () => void
  /** Whether typed prices currently fail to make a range around today's price. */
  invalid: boolean
  disabled: boolean
}

/** Your own lowest and highest price, and which token prices are shown in: under More options. */
export function CustomRange({ pair, custom, onCustom, inverted, onFlip, invalid, disabled }: CustomProps) {
  const [base, quote] = inverted ? [pair.token1, pair.token0] : [pair.token0, pair.token1]
  const unit = `${quote.symbol} per ${base.symbol}`
  const now = currentPrice(pair, inverted)
  return <div className="flex flex-col gap-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">Lowest price
        <input className={`${input} mt-1`} inputMode="decimal" value={custom.min} disabled={disabled}
          placeholder={plainPrice(now * 0.9)} onChange={(event) => onCustom({ ...custom, min: event.target.value })} /></label>
      <label className="block text-sm">Highest price
        <input className={`${input} mt-1`} inputMode="decimal" value={custom.max} disabled={disabled}
          placeholder={plainPrice(now * 1.1)} onChange={(event) => onCustom({ ...custom, max: event.target.value })} /></label>
    </div>
    <p className={`text-sm ${invalid ? 'text-danger' : 'text-ink-muted'}`} role={invalid ? 'alert' : undefined}>
      {invalid ? `Choose prices either side of today's, ${formatPrice(now)} ${unit}.` : `Prices in ${unit}.`}
      <button type="button" className="ml-2 min-h-9 font-medium text-link underline-offset-4 hover:underline" disabled={disabled}
        onClick={onFlip}>Show in {base.symbol}</button></p>
  </div>
}
