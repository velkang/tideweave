import type { MouseEvent } from 'react'
import type { Venue } from './explore-api'

// Screens are plain paths, so they can be linked and the back button works:
// / (Home), /explore, /swap, /positions, /explore/<pool-id> to open one pair on Explore, or /swap/<token>
// to swap a held token.

export type Screen = 'home' | 'explore' | 'swap' | 'positions'
/** `token` is set on /swap/<token>: the token to sell, whose pairs are listed. */
export type Route = { screen: Screen; pair: { venue?: Venue; id: string } | null; token: string | null }

const VENUES: readonly Venue[] = ['uniswap-v3', 'uniswap-v4', 'nadfun-v2']
const ID = /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/
const TOKEN = /^0x[0-9a-fA-F]{40}$/
const SCREENS: readonly Screen[] = ['home', 'explore', 'swap', 'positions']
const NAVIGATED = 'tideweave:navigate'

export function parseRoute(pathname: string): Route {
  const [screen, venue, id] = pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part) } catch { return '' }
  })
  if (screen === 'home' || screen === 'positions') return { screen, pair: null, token: null }
  // On /swap/<token> the second part is the token.
  if (screen === 'swap') return { screen, pair: null, token: venue && TOKEN.test(venue) ? venue : null }
  if (!screen) return { screen: 'home', pair: null, token: null }
  const pair = screen === 'explore' && venue && ID.test(venue) && !id
    ? { id: venue }
    : screen === 'explore' && VENUES.includes(venue as Venue) && id && ID.test(id)
      ? { venue: venue as Venue, id } : null
  return { screen: 'explore', pair, token: null }
}

export const pairHref = (id: string) => `/explore/${encodeURIComponent(id)}`
export const swapHref = (token: string) => `/swap/${encodeURIComponent(token)}`

/** The path for a link from before screens were paths (#positions, #explore/…), or null for any other hash. */
export function legacyHashPath(hash: string): string | null {
  const path = hash.replace(/^#/, '')
  return SCREENS.includes(path.split('/')[0] as Screen) ? `/${path}` : null
}

/** Moves to a path without reloading, as a link would. */
export function navigate(path: string) {
  if (path === window.location.pathname) return
  window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATED))
  window.scrollTo(0, 0)
}

/** Calls `onChange` when the path changes, by a link or by back and forward. */
export function onRouteChange(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATED, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATED, onChange)
  }
}

/** A link's click handler: moves within the app, but leaves new-tab and modified clicks to the browser. */
export function followLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }
  event.preventDefault()
  navigate(event.currentTarget.getAttribute('href') ?? '/')
}
