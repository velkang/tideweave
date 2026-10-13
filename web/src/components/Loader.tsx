type Props = { label?: string }

/** A quiet loading state with an announcement for assistive technology. */
export function Loader({ label = 'Loading' }: Props) {
  return <div role="status" className="flex min-h-40 items-center justify-center">
    <svg className="size-8 animate-spin text-accent motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
    <span className="sr-only">{label}</span>
  </div>
}
