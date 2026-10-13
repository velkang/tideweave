import { useEffect, useRef, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { secondary } from './ui'

type Props = { title: string; description: string; onClose: () => void; children: ReactNode }

/** A side sheet over the page, such as a swap beside the deposit form. Escape or a click outside closes it. */
export function Sheet({ title, description, onClose, children }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Focus once on open; not re-run per render, so typing in the swap keeps focus.
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
      if (event.key !== 'Tab') return
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    className="fixed inset-0 z-70 flex justify-end bg-scrim text-ink"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <motion.section ref={dialogRef} initial={{ x: 40 }} animate={{ x: 0 }} exit={{ x: 40 }} transition={{ duration: 0.2 }}
      role="dialog" aria-modal="true" aria-labelledby="sheet-title"
      className="flex h-full w-[min(560px,100%)] flex-col gap-6 overflow-auto overscroll-contain rounded-l-[28px] bg-paper p-7 shadow-2xl max-[520px]:rounded-none max-[520px]:p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="sheet-title" className="text-2xl font-semibold">{title}</h2>
          {description ? <p className="mt-1.5 text-ink-muted">{description}</p> : null}
        </div>
        <button ref={closeRef} type="button" className={secondary} onClick={onClose}>Close</button>
      </div>
      {children}
    </motion.section>
  </motion.div>
}
