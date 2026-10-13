import type { PairToken } from '../../lib/explore-api'
import { formatAmount, formatToken } from '../../lib/format'

type Props = {
  id: string
  token: PairToken
  value: string
  onChange: (value: string) => void
  /** What the wallet can put in from this side, or null while loading. */
  spendable: bigint | null
  /** Why `spendable` differs from the plain balance, if it does. */
  spendableNote?: string
  /** How much more the typed amount needs than the wallet can put in. */
  missing: bigint
  onSwap: () => void
  disabled: boolean
}

/** One token's amount, with the wallet's balance and, when it is short, a way to get the rest. */
export function AmountField({ id, token, value, onChange, spendable, spendableNote, missing, onSwap,
  disabled }: Props) {
  const short = missing > 0n
  return <div className="min-w-0">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <label htmlFor={id} className="font-semibold">{token.symbol}</label>
      <span className="text-sm text-ink-muted tabular-nums">
        {spendable === null ? 'Reading balance…' : `Balance ${formatToken(spendable, token.decimals)}`}</span>
    </div>
    <input id={id} autoComplete="off" inputMode="decimal" placeholder="0" value={value} disabled={disabled}
      aria-invalid={short || undefined} aria-describedby={`${id}-hint`}
      onChange={(event) => onChange(event.target.value.replace(',', '.'))}
      className="mt-2 min-h-14 w-full rounded-2xl border border-line-strong bg-card px-4 text-xl tabular-nums text-ink outline-none focus-visible:ring-2 focus-visible:ring-link aria-invalid:border-danger-line" />
    <div id={`${id}-hint`} className="mt-1.5 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {short ? <span className="text-danger">{formatAmount(missing, token.decimals)} {token.symbol} short</span>
        : spendableNote ? <span className="text-ink-muted">{spendableNote}</span> : null}
      {short ? <button type="button" disabled={disabled} onClick={onSwap}
        className="font-medium text-link underline-offset-4 hover:underline disabled:opacity-50">
        Get {token.symbol}</button> : null}
    </div>
  </div>
}
