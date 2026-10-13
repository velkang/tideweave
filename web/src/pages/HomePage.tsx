import { followLink } from '../lib/route'
import { button, secondary } from '../components/explore/ui'

export function HomePage({ onOpenWallet }: { onOpenWallet: () => void }) {
  return <div className="home-page">
    <section className="home-hero">
      <div className="home-intro"><h1>Your liquidity.<br /><span>Your next move.</span></h1>
        <p>Explore pools, build positions, and manage your assets on Monad. One place to make every step clear.</p>
        <div className="hero-actions"><a href="/explore" onClick={followLink} className={button}>Explore pools <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12" stroke="currentColor" strokeWidth="1.5" /></svg></a><a href="/positions" onClick={followLink} className={secondary}>View positions</a></div>
        <div className="hero-venues"><span>Uniswap v3</span><span>Hookless v4</span><span>nad.fun</span></div>
      </div>
      <div className="liquidity-diagram" aria-label="Two assets combine into a liquidity position. Fees can be collected back to your wallet.">
        <div className="diagram-caption">Two assets. One position.</div>
        <svg viewBox="0 0 520 330" role="img" aria-label="Assets flow into a position, with fees returning to the wallet">
          <path d="M100 80H170C230 80 230 165 280 165H420M100 250H170C230 250 230 165 280 165" fill="none" stroke="var(--color-line-strong)" strokeWidth="2" />
          <path className="flow-path" d="M100 80H170C230 80 230 165 280 165H420" fill="none" stroke="var(--color-accent)" strokeWidth="3" />
          <path className="flow-path flow-path-second" d="M100 250H170C230 250 230 165 280 165H420" fill="none" stroke="var(--color-accent)" strokeWidth="3" />
          <rect x="26" y="42" width="130" height="76" rx="8" fill="var(--color-field)" stroke="var(--color-line-strong)" />
          <rect x="26" y="212" width="130" height="76" rx="8" fill="var(--color-field)" stroke="var(--color-line-strong)" />
          <text x="91" y="88" textAnchor="middle" fill="var(--color-ink)" fontSize="20">First asset</text><text x="91" y="258" textAnchor="middle" fill="var(--color-ink)" fontSize="20">Second asset</text>
          <rect x="313" y="115" width="170" height="100" rx="8" fill="var(--color-accent)" />
          <text x="398" y="159" textAnchor="middle" fill="var(--color-on-accent)" fontSize="20" fontWeight="600">Your position</text>
          <text x="398" y="185" textAnchor="middle" fill="var(--color-on-accent)" fontSize="14">Tokens in a pool</text>
        </svg>
        <div className="diagram-footnote"><span>Your wallet</span><span>Collect fees. Exit when ready.</span></div>
      </div>
    </section>
    <section className="home-tasks" aria-labelledby="workspace-heading">
      <div className="home-section-heading"><h2 id="workspace-heading">A place for every move.</h2><p>Choose a task. Keep the rest out of your way.</p></div>
      <div className="task-directory">{[
        ['/explore', 'Explore', 'Find pools and add liquidity with both tokens.'],
        ['/swap', 'Swap', 'Exchange tokens through an existing pool.'],
        ['/positions', 'Positions', 'Manage ranges, fees, and position automation.'],
      ].map(([href, title, description]) => <a key={href} href={href} onClick={followLink} className="task-link"><h3>{title}</h3><p>{description}</p><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" /></svg></a>)}</div>
      <button type="button" className="task-link w-full text-left" onClick={onOpenWallet}><h3>Wallet</h3><p>Fund your wallet, view assets, and withdraw from any page.</p><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" /></svg></button>
    </section>
    <section className="home-control"><h2>Set the rules.<br />Stay in control.</h2><div><p>Start with ask-first automation: review a proposed rebalance before it runs. Choose autopilot only when you are ready, with your own limits.</p><a href="/positions" onClick={followLink}>Manage position automation <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12" stroke="currentColor" strokeWidth="1.5" /></svg></a><p className="home-control-note">Automation supports verified v3 and hookless v4 positions. nad.fun positions remain manual.</p></div></section>
  </div>
}
