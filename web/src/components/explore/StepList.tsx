type Props = {
  /** Every transaction, in order. */
  steps: string[]
  /** How many have confirmed. */
  done: number
  running: boolean
}

function stepMark(index: number, done: number, running: boolean) {
  if (index < done) return { mark: '✓', className: 'border-link bg-link text-on-accent', state: 'done' }
  if (index === done && running) return { mark: '…', className: 'border-link text-link', state: 'in progress' }
  return { mark: String(index + 1), className: 'border-line text-ink-muted', state: 'to do' }
}

/** A numbered checklist of the transactions one Confirm runs, ticking each off as it confirms. */
export function StepList({ steps, done, running }: Props) {
  return <ol className="flex flex-col gap-2">{steps.map((step, index) => {
    const { mark, className, state } = stepMark(index, done, running)
    return <li key={`${index}:${step}`} className="flex items-center gap-3 text-sm">
      <span aria-hidden="true" className={`inline-grid size-7 flex-none place-items-center rounded-full border text-xs font-semibold ${className}`}>{mark}</span>
      <span>{step}<span className="sr-only">: {state}</span></span>
    </li>
  })}</ol>
}
