import { describe, expect, it } from 'vitest';
import { buildMonadV3FullWithdrawal, MONAD_TOKENS, type MonadV3Pool } from '@tideweave/chain';
import type { LoadedMainnetIntent } from '../src/mainnet-evaluator';
import { monadAutomationReason } from '../src/monad-automation-policy';
const address = '0x2222222222222222222222222222222222222222' as const;
const pool: MonadV3Pool = { chainId: 143, venue: 'uniswap-v3', id: address,
  token0: { address, symbol: 'TOKEN', decimals: 6 }, token1: { address: MONAD_TOKENS.USDC, symbol: 'USDC', decimals: 6 },
  fee: 3000, tickSpacing: 60, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000_000n };
const close = buildMonadV3FullWithdrawal({ tokenId: 7n, recipient: address, liquidity: 100_000n,
  expected0: 10_000_000n, expected1: 10_000_000n, slippageBps: 100, deadline: 2_000_000_600n });
function intent(): LoadedMainnetIntent {
  return { intentId: 'i', kind: 'monad_v3_mint', status: 'pending', expiresAt: 2_000_000_000_000,
    payloadHash: '0x01', wallet: { address, state: 'active' }, transaction: { chainId: 143, to: address, data: '0x', value: 0n },
    automation: { runId: 'r', runStatus: 'running', runsStartedToday: 1,
      mandate: { status: 'active', poolId: address, maxPositionUsd: 100, maxRunsPerDay: 2 },
      monad: { venue: 'uniswap-v3', tokenId: '7', band: 'balanced', mandateBand: 'balanced', walletMatches: true,
        state: { pending: { intentId: 'i' }, caps: { amount0: '5000000', amount1: '5000000' }, ticks: { tickLower: -1080, tickUpper: 960 } },
        confirmed: [{ kind: 'monad_v3_position_withdraw', calldata: close.data, token_in: null, amount_in: null, amount_out_minimum: null }] } } };
}
const mint = { amount0: 5_000_000n, amount1: 5_000_000n, tickLower: -1080, tickUpper: 960 };
describe('Monad automation signer boundaries', () => {
  it('allows a valued mint within guaranteed proceeds, the saved range, and the mandate', () => {
    expect(monadAutomationReason(intent(), pool, 0.03, mint)).toBeNull();
  });
  it.each(['paused', 'revoked'])('refuses a %s mandate', status => {
    const loaded = intent(); loaded.automation!.mandate!.status = status;
    expect(monadAutomationReason(loaded, pool, 0.03, mint)).toBe('MANDATE_NOT_ACTIVE');
  });
  it('requires the current run, wallet, pool, venue, and prepared step', () => {
    const wrongRun = intent(); wrongRun.automation!.runStatus = 'done';
    expect(monadAutomationReason(wrongRun, pool, .03, mint)).toBe('MANDATE_RUN_NOT_RUNNING');
    const wrongWallet = intent(); wrongWallet.automation!.monad!.walletMatches = false;
    expect(monadAutomationReason(wrongWallet, pool, .03, mint)).toBe('MANDATE_POOL_NOT_ALLOWED');
    const wrongVenue = intent(); wrongVenue.automation!.monad!.venue = 'uniswap-v4';
    expect(monadAutomationReason(wrongVenue, pool, .03, mint)).toBe('MANDATE_POOL_NOT_ALLOWED');
    const wrongStep = intent(); wrongStep.automation!.monad!.state!.pending!.intentId = 'other';
    expect(monadAutomationReason(wrongStep, pool, .03, mint)).toBe('MANDATE_STEP_NOT_ALLOWED');
  });
  it('refuses a position other than the selected NFT and excludes partial actions', () => {
    const loaded = intent(); loaded.kind = 'monad_v3_position_withdraw';
    expect(monadAutomationReason(loaded, pool, null, { tokenId: 7n })).toBeNull();
    expect(monadAutomationReason(loaded, pool, null, { tokenId: 8n })).toBe('MANDATE_POSITION_NOT_ALLOWED');
    loaded.kind = 'monad_v3_position_decrease';
    expect(monadAutomationReason(loaded, pool, null, { tokenId: 7n })).toBe('MANDATE_POSITION_NOT_ALLOWED');
  });
  it('requires known anchor valuation and sufficient depth for spending', () => {
    expect(monadAutomationReason(intent(), { ...pool, liquidity: 1n }, .03, mint)).toBe('MANDATE_VALUE_UNKNOWN');
    expect(monadAutomationReason(intent(), { ...pool, token1: { ...pool.token1, address: '0x3333333333333333333333333333333333333333' } }, .03, mint)).toBe('MANDATE_VALUE_UNKNOWN');
    const loaded = intent(); loaded.automation!.mandate!.maxPositionUsd = 1;
    expect(monadAutomationReason(loaded, pool, .03, mint)).toBe('MANDATE_VALUE_EXCEEDS_LIMIT');
  });
  it('checks the daily run limit on every submission', () => {
    const loaded = intent(); loaded.automation!.runsStartedToday = 3;
    expect(monadAutomationReason(loaded, pool, .03, mint)).toBe('MANDATE_DAILY_LIMIT_REACHED');
  });
  it('refuses larger approvals or mint budgets, even if the wallet has extra deposits', () => {
    expect(monadAutomationReason(intent(), pool, .03, { ...mint, amount0: 5_000_001n })).toBe('MANDATE_PROCEEDS_EXCEEDED');
    const loaded = intent(); loaded.automation!.monad!.state!.caps!.amount0 = '100000000';
    expect(monadAutomationReason(loaded, pool, .03, mint)).toBe('MANDATE_PROCEEDS_EXCEEDED');
  });
  it('accounts for confirmed swap input and only its guaranteed output', () => {
    const loaded = intent(); loaded.automation!.monad!.confirmed.push({ kind: 'monad_swap', calldata: null,
      token_in: address, amount_in: '8000000', amount_out_minimum: '1000000' });
    expect(monadAutomationReason(loaded, pool, .03, mint)).toBe('MANDATE_PROCEEDS_EXCEEDED');
    loaded.automation!.monad!.state!.caps!.amount0 = '1900000';
    expect(monadAutomationReason(loaded, pool, .03, { ...mint, amount0: 1_900_000n })).toBeNull();
  });
  it('refuses a second mint or swap after that step has confirmed', () => {
    const loaded = intent(); loaded.automation!.monad!.confirmed.push({ kind: 'monad_v3_mint', calldata: null,
      token_in: null, amount_in: null, amount_out_minimum: null });
    expect(monadAutomationReason(loaded, pool, .03, mint)).toBe('MANDATE_STEP_ALREADY_CONFIRMED');
  });
  it('rejects changed presets, changed ticks, or widths outside the saved preset', () => {
    const loaded = intent(); loaded.automation!.monad!.mandateBand = 'wide';
    expect(monadAutomationReason(loaded, pool, .03, mint)).toBe('MANDATE_BAND_NOT_ALLOWED');
    expect(monadAutomationReason(intent(), pool, .03, { ...mint, tickLower: -5000 })).toBe('MANDATE_BAND_NOT_ALLOWED');
  });
});
