import { AutomationStatus } from './components/positions/AutomationStatus'
import { useCallback, useEffect, useState } from 'react'
import { AuthScreen } from './components/AuthScreen'
import { ToastContainer, type ToastMessage } from './components/Toast'
import { ExplorePage } from './pages/ExplorePage'
import { PositionsPage } from './pages/PositionsPage'
import { HomePage } from './pages/HomePage'
import { Sheet } from './components/explore/Sheet'
import { AnimatePresence } from 'motion/react'
import { Brand } from './components/Brand'
import { button } from './components/explore/ui'
import { WalletPanel } from './components/wallet/WalletPanel'
import { SwapPage } from './pages/SwapPage'
import { followLink, legacyHashPath, navigate, onRouteChange, pairHref, parseRoute, swapHref } from './lib/route'
import { api, ApiError, type AuthUser, type ManagedWalletRecord } from './lib/api-client'
import { TransactionContext, useTransactions } from './lib/execute'
import { TransactionState } from './lib/transaction-state'

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [wallet, setWallet] = useState<ManagedWalletRecord | null>(null)
  const [walletOpen, setWalletOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [route, setRoute] = useState(() => parseRoute(legacyHashPath(window.location.hash) ?? window.location.pathname))
  const screen = route.screen
  useEffect(() => {
    document.title = `${screen === 'home' ? 'Liquidity on Monad' : screen.charAt(0).toUpperCase() + screen.slice(1)} · Tideweave`
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [screen, route.pair?.id])
  useEffect(() => {
    // An old #positions-style link becomes its path.
    const legacy = legacyHashPath(window.location.hash)
    if (legacy) window.history.replaceState(null, '', legacy)
    const pair = parseRoute(window.location.pathname).pair
    if (pair?.venue) window.history.replaceState(null, '', pairHref(pair.id))
    return onRouteChange(() => setRoute(parseRoute(window.location.pathname)))
  }, [])

  const notify = useCallback((type: ToastMessage['type'], title: string, message?: string) => {
    const id = crypto.randomUUID()
    setToasts((current) => [...current, { id, type, title, message }])
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 7000)
  }, [])
  const [transactions] = useState(() => new TransactionState(api, notify))
  useEffect(() => {
    transactions.reset()
    if (user) void transactions.recover()
    return () => transactions.reset()
  }, [user?.id, transactions])

  const refreshWallet = useCallback(async () => {
    try { setWallet((await api.getMyWallet()).wallet) }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) setWallet(null)
      else throw error
    }
  }, [])

  useEffect(() => {
    let active = true
    api.getMe().then(({ user: current }) => { if (active) setUser(current) })
      .catch(() => { if (active) setUser(null) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (user) void refreshWallet().catch(() => notify('error', 'Wallet could not refresh'))
    else setWallet(null)
  }, [user, refreshWallet, notify])

  const provision = async () => {
    try { await api.provisionWallet(); await refreshWallet(); notify('success', 'Wallet ready') }
    catch (error) { notify('error', 'Wallet creation failed', String(error)) }
  }
  const logout = async () => {
    try { await api.logout() } catch { /* Local session still clears. */ }
    setUser(null); setWallet(null); setWalletOpen(false)
  }

  return <TransactionContext.Provider value={transactions}>
    <div className="flex min-h-screen flex-col bg-paper text-ink">
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[90] focus:rounded-full focus:bg-accent focus:px-5 focus:py-3 focus:text-on-accent">Skip to content</a>
    <header className="site-header">
      <div className="site-header-inner">
        <a href="/" onClick={followLink} className="brand-link" aria-label="Tideweave home"><Brand /></a>
        <nav aria-label="Main navigation" className="site-nav">{([['home', 'Home', '/'], ['explore', 'Explore', '/explore'], ['swap', 'Swap', '/swap'], ['positions', 'Positions', '/positions']] as const).map(([id, label, href]) =>
          <a key={id} href={href} onClick={followLink} aria-current={screen === id ? 'page' : undefined}>{label}</a>)}</nav>
        <div className="site-account">{user ? <>
          <button type="button" onClick={() => setWalletOpen(true)} aria-label="Open managed wallet" className="account-address"><span aria-hidden="true" className={wallet?.state === 'active' ? 'connection-dot' : ''} />{wallet?.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'Create wallet'}</button>
        </> : <button type="button" className={button} onClick={() => setAuthOpen(true)}>Connect wallet</button>}</div>
      </div>
    </header>
    <AutomationStatus wallet={wallet} onSettled={refreshWallet} />
    <TransactionNotice />
    <main id="main" tabIndex={-1} className={`site-main ${screen === 'home' ? 'site-main-home' : screen === 'swap' ? 'site-main-swap' : ''}`}>
      {screen !== 'home' && screen !== 'swap' && !route.pair ? <div className="page-wayfinding"><a href="/" onClick={followLink}>Home</a><span aria-hidden="true">/</span><span>{screen.charAt(0).toUpperCase() + screen.slice(1)}</span></div> : null}
      {screen === 'home' ? <HomePage onOpenWallet={() => user ? setWalletOpen(true) : setAuthOpen(true)} />
        : screen === 'swap'
        ? <SwapPage wallet={wallet} token={route.token} onRefreshWallet={refreshWallet} onNotify={notify} onSignIn={() => setAuthOpen(true)} />
        : screen === 'positions'
          ? <PositionsPage wallet={wallet} signedIn={user !== null} onSignIn={() => setAuthOpen(true)}
            onOpenWallet={() => setWalletOpen(true)}
            onOpenPair={(_venue, id) => navigate(pairHref(id))}
            onRefreshWallet={refreshWallet} onNotify={notify} />
          : <ExplorePage wallet={wallet} openPair={route.pair} onRefreshWallet={refreshWallet} onNotify={notify} />}
    </main>
    {screen !== 'swap' ? <footer className="site-footer"><a href="/" onClick={followLink}><Brand compact /></a><p>Liquidity on Monad.</p><nav aria-label="Footer navigation">{screen !== 'explore' ? <a href="/explore" onClick={followLink}>Explore pools</a> : null}<button type="button" className="min-h-11" onClick={() => user ? setWalletOpen(true) : setAuthOpen(true)}>Manage wallet</button></nav></footer> : null}
    <AnimatePresence>
      {walletOpen && user ? <Sheet key="wallet" title="Managed wallet" onClose={() => setWalletOpen(false)}
        description="Fund your wallet, view assets, and withdraw to your owner wallet.">
        <WalletPanel wallet={wallet} canProvision ownerAddress={user.ownerAddress ?? user.address}
          onProvision={provision} onRefreshWallet={refreshWallet} onNotify={notify}
          onSwapToken={token => { setWalletOpen(false); navigate(swapHref(token)) }}
          onSignOut={() => void logout()} />
      </Sheet> : null}
    </AnimatePresence>
    {authOpen ? <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setAuthOpen(false)
    }}><AuthScreen onAuthSuccess={(next) => { setUser(next); setAuthOpen(false) }}
      onError={(message) => notify('error', 'Sign-in failed', message)}
      onClose={() => setAuthOpen(false)} /></div> : null}
    <ToastContainer toasts={toasts} onDismiss={(id) =>
      setToasts((current) => current.filter((toast) => toast.id !== id))} />
  </div></TransactionContext.Provider>
}

function TransactionNotice() {
  const { controller, attempt: latestAttempt, busy, polling, automationBusy } = useTransactions()
  const attempt = latestAttempt?.status === 'confirmed' ? null : latestAttempt
  if (!attempt && (!busy || (automationBusy && !controller.snapshot().busy))) return null
  return <div role="status" className="border-b border-line bg-tint px-[clamp(16px,4vw,80px)] py-3 text-sm">
    <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-3">
      <span>{busy || `Transaction ${attempt?.status}`}</span>
      {attempt?.transactionHash ? <a className="text-link underline" href={`https://monadscan.com/tx/${attempt.transactionHash}`}
        target="_blank" rel="noreferrer">View transaction <svg className="ml-1 inline size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12" stroke="currentColor" strokeWidth="1.5" /></svg></a> : null}
      {busy && !polling ? <button type="button" className="min-h-11 rounded-full border border-line-strong px-4"
        onClick={() => { window.dispatchEvent(new Event('automation-check')); void controller.recover() }}>Check status</button> : null}
    </div>
  </div>
}
