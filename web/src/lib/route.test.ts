import { describe, expect, it } from 'vitest'
import { legacyHashPath, pairHref, parseRoute, swapHref } from './route'

describe('routes', () => {
  it('reads the screen and an optional pair from the path', () => {
    for (const screen of ['home']) expect(parseRoute(`/${screen}`)).toEqual({ screen, pair: null, token: null })
    expect(parseRoute('/positions')).toEqual({ screen: 'positions', pair: null, token: null })
    expect(parseRoute('/swap/')).toEqual({ screen: 'swap', pair: null, token: null })
    expect(parseRoute('/')).toEqual({ screen: 'home', pair: null, token: null })
    expect(parseRoute('/explore')).toEqual({ screen: 'explore', pair: null, token: null })
    const id = `0x${'5f'.repeat(32)}`
    expect(pairHref(id)).toBe(`/explore/${id}`)
    expect(parseRoute(pairHref(id))).toEqual({ screen: 'explore', pair: { id }, token: null })
    expect(parseRoute(`/explore/uniswap-v4/${id}`).pair).toEqual({ venue: 'uniswap-v4', id })
    expect(parseRoute('/explore/nadfun-v2/0xbd1BEbC1CA6cE1955eD5Ec466b89da58051d8f4E').pair?.venue).toBe('nadfun-v2')
  })

  it('ignores an unknown venue, a malformed id or an unknown screen', () => {
    expect(parseRoute('/explore/sushi/0x1111111111111111111111111111111111111111').pair).toBeNull()
    expect(parseRoute('/explore/uniswap-v3/0x123').pair).toBeNull()
    expect(parseRoute('/explore/0x123').pair).toBeNull()
    expect(parseRoute('/explore/0x1111111111111111111111111111111111111111').pair).toEqual({ id: '0x1111111111111111111111111111111111111111' })
    expect(parseRoute('/explore/uniswap-v3/%3Cscript%3E').pair).toBeNull()
    expect(parseRoute('/nowhere')).toEqual({ screen: 'explore', pair: null, token: null })
  })

  it('opens Swap on one token, native MON included, ignoring anything that is not an address', () => {
    const usdc = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
    expect(swapHref(usdc)).toBe(`/swap/${usdc}`)
    expect(parseRoute(swapHref(usdc))).toEqual({ screen: 'swap', pair: null, token: usdc })
    expect(parseRoute('/swap/0x0000000000000000000000000000000000000000').token).toBe('0x0000000000000000000000000000000000000000')
    expect(parseRoute('/swap/USDC').token).toBeNull()
    expect(parseRoute(`/swap/0x${'5f'.repeat(32)}`).token).toBeNull()
  })

  it('turns an old #screen link into its path, and leaves other hashes alone', () => {
    expect(legacyHashPath('#positions')).toBe('/positions')
    expect(legacyHashPath('#explore/uniswap-v3/0x659bD0BC4167BA25c62E05656F78043E7eD4a9da'))
      .toBe('/explore/uniswap-v3/0x659bD0BC4167BA25c62E05656F78043E7eD4a9da')
    expect(legacyHashPath('#main')).toBeNull()
    expect(legacyHashPath('')).toBeNull()
  })
})
