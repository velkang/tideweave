import { zeroAddress } from 'viem'
import { exploreApi, type PairAssets, type PairDetail, type Position, type Prepared } from './explore-api'

// Everything that differs between pool types lives here; the Explore screen only uses this
// interface. v3 approves the position manager, v4 approves Permit2 and then the position
// manager through Permit2 (never native MON), and nad.fun needs no approvals: its deposit and
// exit each run as one batch from the managed wallet.

export type Step = { label: string; prepare: () => Promise<Prepared> }
export type DepositInput = { pair: PairDetail; amount0: bigint; amount1: bigint; slippageBps: number;
  tickLower?: number; tickUpper?: number; wrapAmount?: bigint }

export type VenueAdapter = {
  /** Whether a deposit chooses a price range (ticks). */
  usesRange: boolean
  /** Approvals still needed for these amounts, in the order they must run. */
  approvalSteps(assets: PairAssets, amounts: [bigint, bigint]): Step[]
  prepareDeposit(input: DepositInput): Promise<Prepared>
  /** Collects earned fees into the wallet; null where fees grow the position instead (nad.fun). */
  collectStep(position: Position): Step | null
  /** Whether part of a position can be removed, rather than only all of it. */
  partialRemove: boolean
  /**
   * The transactions that return `percent` of the position to the wallet. 100 closes it, fees included.
   * v3 leaves a partial decrease owed, so a collect follows it.
   */
  removeSteps(position: Position, percent: number): Step[]
}

const share = (position: Position, percent: number) => BigInt(position.liquidity) * BigInt(percent) / 100n

const key = () => crypto.randomUUID()
const deadline = () => String(Math.floor(Date.now() / 1000) + 600)
// Permit2 approvals last a little under the API's three-day limit.
const permit2Expiry = () => String(Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60 - 600)

const v3: VenueAdapter = {
  usesRange: true,
  approvalSteps(assets, amounts) {
    return [assets.token0, assets.token1].flatMap((token, index) => {
      const approval = assets.approvals.find((item) => item.token.toLowerCase() === token.address.toLowerCase())
      const amount = amounts[index]
      if (!approval || amount <= 0n || BigInt(approval.allowance) >= amount) return []
      return [{ label: `Approve ${token.symbol}`, prepare: () => exploreApi.prepareV3Approval({ poolAddress: assets.id,
        tokenAddress: token.address, amount: amount.toString(), idempotencyKey: key() }) }]
    })
  },
  prepareDeposit: ({ pair, amount0, amount1, slippageBps, tickLower, tickUpper }) => exploreApi.prepareV3Mint({
    poolAddress: pair.id, amount0Desired: amount0.toString(), amount1Desired: amount1.toString(),
    tickLower: tickLower ?? 0, tickUpper: tickUpper ?? 0, slippageBps, deadline: deadline(), idempotencyKey: key() }),
  collectStep: (position) => ({ label: 'Collect fees', prepare: () => exploreApi.prepareV3Action({ action: 'collect',
    tokenId: position.id, idempotencyKey: key() }) }),
  partialRemove: true,
  removeSteps(position, percent) {
    if (percent >= 100) {
      return [{ label: 'Close position', prepare: () => exploreApi.prepareV3Action({ action: 'withdraw',
        tokenId: position.id, slippageBps: 100, deadline: deadline(), idempotencyKey: key() }) }]
    }
    return [
      { label: `Remove ${percent}%`, prepare: () => exploreApi.prepareV3Action({ action: 'decrease', tokenId: position.id,
        liquidity: share(position, percent).toString(), slippageBps: 100, deadline: deadline(), idempotencyKey: key() }) },
      { label: 'Collect to wallet', prepare: () => exploreApi.prepareV3Action({ action: 'collect', tokenId: position.id,
        idempotencyKey: key() }) },
    ]
  },
}

const v4: VenueAdapter = {
  usesRange: true,
  approvalSteps(assets, amounts) {
    const soon = BigInt(Math.floor(Date.now() / 1000) + 900)
    return [assets.token0, assets.token1].flatMap((token, index) => {
      const amount = amounts[index]
      if (token.address === zeroAddress || amount <= 0n) return []
      const layer = (stage: 'erc20' | 'permit2') => assets.approvals.find((item) => item.stage === stage &&
        item.token.toLowerCase() === token.address.toLowerCase())
      const erc20 = layer('erc20')
      const permit2 = layer('permit2')
      const steps: Step[] = []
      if (!erc20 || BigInt(erc20.allowance) < amount) {
        steps.push({ label: `Approve ${token.symbol} for Permit2`, prepare: () => exploreApi.prepareV4Approval({
          poolId: assets.id, tokenAddress: token.address, stage: 'erc20', amount: amount.toString(),
          idempotencyKey: key() }) })
      }
      if (!permit2 || BigInt(permit2.allowance) < amount || BigInt(permit2.expiration ?? '0') <= soon) {
        steps.push({ label: `Allow ${token.symbol} through Permit2`, prepare: () => exploreApi.prepareV4Approval({
          poolId: assets.id, tokenAddress: token.address, stage: 'permit2', amount: amount.toString(),
          expiration: permit2Expiry(), idempotencyKey: key() }) })
      }
      return steps
    })
  },
  prepareDeposit: ({ pair, amount0, amount1, slippageBps, tickLower, tickUpper }) => exploreApi.prepareV4Mint({
    poolId: pair.id, amount0Desired: amount0.toString(), amount1Desired: amount1.toString(),
    tickLower: tickLower ?? 0, tickUpper: tickUpper ?? 0, slippageBps, deadline: deadline(), idempotencyKey: key() }),
  collectStep: (position) => ({ label: 'Collect fees', prepare: () => exploreApi.prepareV4Action({ action: 'collect',
    tokenId: position.id, slippageBps: 100, deadline: deadline(), idempotencyKey: key() }) }),
  partialRemove: true,
  // A v4 decrease takes its tokens and earned fees to the wallet in the same transaction.
  removeSteps: (position, percent) => [percent >= 100
    ? { label: 'Close position', prepare: () => exploreApi.prepareV4Action({ action: 'withdraw', tokenId: position.id,
      slippageBps: 100, deadline: deadline(), idempotencyKey: key() }) }
    : { label: `Remove ${percent}%`, prepare: () => exploreApi.prepareV4Action({ action: 'decrease', tokenId: position.id,
      removeBps: percent * 100, slippageBps: 100, deadline: deadline(), idempotencyKey: key() }) }],
}

const nadfun: VenueAdapter = {
  usesRange: false,
  approvalSteps: () => [],
  prepareDeposit: ({ pair, amount0, amount1, slippageBps, wrapAmount }) => exploreApi.prepareNadDeposit(pair.id, {
    amount0Desired: amount0.toString(), amount1Desired: amount1.toString(), slippageBps,
    ...(wrapAmount && wrapAmount > 0n ? { wrapAmount: wrapAmount.toString() } : {}), idempotencyKey: key() }),
  collectStep: () => null,
  partialRemove: true,
  removeSteps: (position, percent) => [{ label: percent >= 100 ? 'Close position' : `Remove ${percent}%`,
    prepare: () => exploreApi.prepareNadWithdraw(position.id, { slippageBps: 100, idempotencyKey: key(),
      ...(percent >= 100 ? {} : { liquidity: share(position, percent).toString() }) }) }],
}

export const VENUES = { 'uniswap-v3': v3, 'uniswap-v4': v4, 'nadfun-v2': nadfun } as const
