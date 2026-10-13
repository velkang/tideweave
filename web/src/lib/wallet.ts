import { isAddress, zeroAddress } from 'viem'
import { MONAD_DELEGATED_RESERVE } from '@tideweave/chain'
import type { PairAssets, WalletBalances } from './explore-api'

/** MON kept back for a withdrawal's own fee: a plain transfer costs far less. */
export const WITHDRAW_GAS_BUFFER = 5n * 10n ** 16n

/** How much of an asset can leave the wallet: all of a token; MON less the fee and any nad.fun reserve. */
export function withdrawable(balances: WalletBalances, asset: string): bigint {
  if (asset.toLowerCase() === zeroAddress) {
    const spare = BigInt(balances.mon.balance) - BigInt(balances.reserve) - WITHDRAW_GAS_BUFFER
    return spare > 0n ? spare : 0n
  }
  const token = balances.tokens.find((held) => held.address.toLowerCase() === asset.toLowerCase())
  return token ? BigInt(token.balance) : 0n
}

/** Why a send can't go ahead yet, or null when it can. */
export function sendProblem(input: { wallet: string; recipient: string; amount: bigint; available: bigint }): string | null {
  const recipient = input.recipient.trim()
  if (!recipient) return 'Enter the address to send to.'
  if (!isAddress(recipient) || recipient.toLowerCase() === zeroAddress) return 'Check the address: it is not a Monad address.'
  if (recipient.toLowerCase() === input.wallet.toLowerCase()) return 'That is this wallet. Enter a different address.'
  if (input.amount > input.available) return 'That is more than you can send.'
  return null
}

/** MON kept back when selling MON in a swap, for the swap's own fee. */
export const SWAP_GAS_BUFFER = 10n ** 17n

/**
 * How much of a pair's token `index` a swap can sell: all of a token; MON less the fee and, on a
 * nad.fun-delegated wallet, Monad's 10 MON reserve.
 */
export function swapSpendable(assets: PairAssets, index: 0 | 1): bigint {
  const token = index === 0 ? assets.token0 : assets.token1
  if (token.address.toLowerCase() !== zeroAddress) return BigInt(token.balance)
  const kept = SWAP_GAS_BUFFER + (assets.delegate ? MONAD_DELEGATED_RESERVE : 0n)
  const spare = BigInt(assets.monBalance) - kept
  return spare > 0n ? spare : 0n
}
