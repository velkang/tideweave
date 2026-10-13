import { BANDS, automationValue, withdrawalMinimums, type AutomationPool } from '@tideweave/chain';
import type { LoadedMainnetIntent } from './mainnet-evaluator';

export type MonadAutomation = {
  venue: string; tokenId: string; band: string; mandateBand: string; walletMatches: boolean;
  state: { pending?: { intentId: string }; caps?: { amount0: string; amount1: string };
    ticks?: { tickLower: number; tickUpper: number } } | null;
  confirmed: Array<{ kind: string; calldata: `0x${string}` | null; token_in: string | null;
    amount_in: string | null; amount_out_minimum: string | null }>;
};

/** Additional deterministic limits, checked after ordinary Monad policy. */
export function monadAutomationReason(loaded: LoadedMainnetIntent, pool: AutomationPool, monUsd: number | null,
  action: { tokenId?: bigint; amount0?: bigint; amount1?: bigint; tickLower?: number; tickUpper?: number }): string | null {
  const context = loaded.automation;
  if (!context) return null;
  const mandate = context.mandate, run = context.monad;
  if (!mandate || mandate.status !== 'active') return 'MANDATE_NOT_ACTIVE';
  if (context.runStatus !== 'running') return 'MANDATE_RUN_NOT_RUNNING';
  if (loaded.wallet.state !== 'active') return 'MANDATE_WALLET_NOT_ACTIVE';
  if (!run || !run.walletMatches || pool.venue !== run.venue || pool.id.toLowerCase() !== mandate.poolId.toLowerCase()) return 'MANDATE_POOL_NOT_ALLOWED';
  if (context.runsStartedToday > mandate.maxRunsPerDay) return 'MANDATE_DAILY_LIMIT_REACHED';
  if (run.state?.pending?.intentId !== loaded.intentId) return 'MANDATE_STEP_NOT_ALLOWED';
  if (action.tokenId !== undefined) return action.tokenId.toString() === run.tokenId &&
    (loaded.kind.endsWith('_withdraw') || loaded.kind.endsWith('_collect')) ? null : 'MANDATE_POSITION_NOT_ALLOWED';
  const valued = automationValue(pool, { amount0: action.amount0 ?? 0n, amount1: action.amount1 ?? 0n }, monUsd);
  if (valued === null) return 'MANDATE_VALUE_UNKNOWN';
  if (valued > mandate.maxPositionUsd) return 'MANDATE_VALUE_EXCEEDS_LIMIT';
  const close = run.confirmed.find(row => row.kind.endsWith('_withdraw'));
  if (!close?.calldata || !run.state?.caps) return 'MANDATE_PROCEEDS_UNKNOWN';
  try {
    const minimums = withdrawalMinimums(pool.venue, close.calldata);
    const budget = [minimums.amount0, minimums.amount1];
    let swaps = 0, mints = 0;
    for (const row of run.confirmed) {
      if (row.kind === 'monad_swap') {
        swaps++;
        const side = row.token_in?.toLowerCase() === pool.token0.address.toLowerCase() ? 0
          : row.token_in?.toLowerCase() === pool.token1.address.toLowerCase() ? 1 : -1;
        if (side < 0 || !row.amount_in || !row.amount_out_minimum) return 'MANDATE_PROCEEDS_INVALID';
        budget[side] -= BigInt(row.amount_in); budget[1 - side] += BigInt(row.amount_out_minimum);
      }
      if (row.kind === 'monad_v3_mint' || row.kind === 'monad_v4_mint') mints++;
    }
    if (mints || (loaded.kind === 'monad_swap' && swaps)) return 'MANDATE_STEP_ALREADY_CONFIRMED';
    const caps = [BigInt(run.state.caps.amount0), BigInt(run.state.caps.amount1)];
    if (caps.some((cap, i) => cap < 0n || cap > budget[i]) ||
      (action.amount0 ?? 0n) > caps[0] || (action.amount1 ?? 0n) > caps[1]) return 'MANDATE_PROCEEDS_EXCEEDED';
    if (action.tickLower !== undefined || action.tickUpper !== undefined) {
      if ((run.mandateBand !== 'agent' && run.mandateBand !== run.band) || !(run.band in BANDS) ||
        action.tickLower !== run.state.ticks?.tickLower || action.tickUpper !== run.state.ticks?.tickUpper) return 'MANDATE_BAND_NOT_ALLOWED';
      // Width must match the saved preset; centring may precede the run's swap.
      const width = action.tickUpper! - action.tickLower!;
      // bandTicks uses lower=(1-spread), upper=(1+spread).
      const widthForBand = Math.log((1 + BANDS[run.band as keyof typeof BANDS]) / (1 - BANDS[run.band as keyof typeof BANDS])) / Math.log(1.0001);
      if (!Number.isFinite(widthForBand) || Math.abs(width - widthForBand) > 2 * pool.tickSpacing) return 'MANDATE_BAND_NOT_ALLOWED';
    }
    return null;
  } catch { return 'MANDATE_PROCEEDS_INVALID'; }
}
