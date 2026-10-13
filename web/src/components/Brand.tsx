/** Two streams crossing into a single T: the same mark in the site header and favicon. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className={`brand ${compact ? 'brand-compact' : ''}`}><svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M5 9h30M9 17h22M14 25h12M20 9v26" stroke="currentColor" strokeWidth="4" strokeLinecap="square" />
  </svg><span>Tideweave</span></span>
}
