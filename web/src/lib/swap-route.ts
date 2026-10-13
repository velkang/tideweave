import { zeroAddress } from 'viem'
import { exploreApi, type PairAssets, type PairListItem, type PairToken, type WalletBalances } from './explore-api'
import { SWAP_GAS_BUFFER } from './wallet'

// Token helpers for swaps: the user picks what they sell and what they get by token, not by pool. Routes between
// them (direct, or through one token in between) are found in routing.ts.

/** Native MON, as the pools and the swap API name it. */
export const MON: PairToken = { address: zeroAddress, symbol: 'MON', decimals: 18 }

/** Pages of a token's pairs read when looking for a pool. */
const MAX_PAGES = 3

export const sameToken = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const isMon = (token: PairToken) => sameToken(token.address, zeroAddress)

const holds = (pair: PairListItem, address: string) =>
  sameToken(pair.token0.address, address) || sameToken(pair.token1.address, address)

/** Every token that `token` trades with in `pairs`, once each: what a user could swap it for directly. */
export function tradedWith(pairs: readonly PairListItem[], token: string): PairToken[] {
  const found = new Map<string, PairToken>()
  for (const pair of pairs) {
    if (!holds(pair, token)) continue
    const other = sameToken(pair.token0.address, token) ? pair.token1 : pair.token0
    if (!found.has(other.address.toLowerCase())) found.set(other.address.toLowerCase(), other)
  }
  return [...found.values()]
}

/** The tokens in a page of pairs, once each, in the order they first appear. */
export function tokensIn(pairs: readonly PairListItem[]): PairToken[] {
  const found = new Map<string, PairToken>()
  for (const pair of pairs) for (const token of [pair.token0, pair.token1]) {
    if (!found.has(token.address.toLowerCase())) found.set(token.address.toLowerCase(), token)
  }
  return [...found.values()]
}

/** Reads a token's pairs (the address search also asks the indexer to discover new ones). */
export async function pairsOf(token: PairToken): Promise<PairListItem[]> {
  const pairs: PairListItem[] = []
  let offset: number | null = 0
  for (let page = 0; page < MAX_PAGES && offset !== null; page += 1) {
    const result: { pools: PairListItem[]; nextOffset: number | null } = await exploreApi.listPairs(token.address, offset)
    pairs.push(...result.pools)
    offset = result.nextOffset
  }
  return pairs
}

/** What a swap can sell of `token`: all of a token; MON less the swap's fee and any nad.fun reserve. */
export function sellable(token: PairToken, balances: WalletBalances | null): bigint | null {
  if (!balances) return null
  if (isMon(token)) {
    const kept = SWAP_GAS_BUFFER + (balances.delegate ? BigInt(balances.reserve) : 0n)
    const spare = BigInt(balances.mon.balance) - kept
    return spare > 0n ? spare : 0n
  }
  const held = balances.tokens.find((entry) => sameToken(entry.address, token.address))
  return held ? BigInt(held.balance) : 0n
}

/** What the wallet holds of `token`, for display. */
export function heldAmount(token: PairToken, balances: WalletBalances | null): bigint | null {
  if (!balances) return null
  if (isMon(token)) return BigInt(balances.mon.balance)
  const held = balances.tokens.find((entry) => sameToken(entry.address, token.address))
  return held ? BigInt(held.balance) : 0n
}

/**
 * Wallet balances with a pool's exact reads laid over them: the wallet list only covers known tokens, so a
 * token bought elsewhere still shows its real balance once a pool holding it is found.
 */
export function withPairAssets(balances: WalletBalances, assets: PairAssets | null): WalletBalances {
  if (!assets) return balances
  const read = [assets.token0, assets.token1].filter((token) => !sameToken(token.address, zeroAddress))
  const others = balances.tokens.filter((held) => !read.some((token) => sameToken(token.address, held.address)))
  const usd = (address: string) => balances.tokens.find((held) => sameToken(held.address, address))?.usd ?? null
  return { ...balances, mon: { ...balances.mon, balance: assets.monBalance }, delegate: assets.delegate,
    tokens: [...others, ...read.map((token) => ({ address: token.address, symbol: token.symbol,
      decimals: token.decimals, balance: token.balance, usd: usd(token.address) }))] }
}
