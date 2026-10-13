import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MONAD_TOKENS, type MonadV3PoolClient } from '@tideweave/chain';
import { zeroAddress, type Address } from 'viem';
import { watchWallet, reserveModelCall, type WatchChain } from '../src/watcher';
const chainMocks = vi.hoisted(() => ({ position: vi.fn(), mon: vi.fn(), fees: vi.fn() }));
vi.mock('@tideweave/chain', async original => ({ ...await original<object>(), readMonadV3Position: chainMocks.position,
  readMonadV4Position: chainMocks.position, readMonUsd: chainMocks.mon, readV3Fees: chainMocks.fees, readV4Fees: chainMocks.fees }));
const owner = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const now = 2_000_000_000_000;
const pool = { chainId: 143, venue: 'uniswap-v3', id: token, token0: { address: token, symbol: 'A', decimals: 6 },
  token1: { address: MONAD_TOKENS.USDC, symbol: 'USDC', decimals: 6 }, fee: 3000, tickSpacing: 60,
  sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000_000n, hooks: zeroAddress, lpFee: 3000 };
function fixture(options: { mode?: string; band?: string; limit?: number; runs?: number; open?: boolean; minted?: boolean; paused?: boolean; venue?: string } = {}) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const mandate = { id: 'm', pool_id: token, token_id: '7', venue: options.venue ?? 'uniswap-v3', mode: options.mode ?? 'ask',
    band: options.band ?? 'balanced', max_position_usd: options.limit ?? 1000, max_runs_per_day: 2 };
  const db = { prepare(sql: string) { let args: unknown[] = []; return {
    bind(...values: unknown[]) { args = values; return this },
    async first() {
      if (sql.includes('SELECT id, address, state')) return { id: 'w', address: owner, state: options.paused ? 'paused' : 'active' };
      if (sql.includes('SELECT mi.token_id')) return options.minted === false ? null : { token_id: '7' };
      if (sql.includes('COUNT(*)')) return { runs: options.runs ?? 0 };
      if (sql.includes('ORDER BY created_at')) return options.open ? { id: 'r', status: 'running', created_at: now - 10_000_000 } : null;
      if (sql.includes('RETURNING calls')) return { calls: 1 };
      return null;
    }, async all() { return { results: [mandate] } },
    async run() { writes.push({ sql, args }); return { meta: { changes: 1 } } },
  } } } as unknown as D1Database;
  const chain = { getBlock: async () => ({ number: 100n }), getGasPrice: async () => 1_000_000_000n } as unknown as WatchChain;
  const decide = vi.fn(async () => ({ provider: 'kimi' as const, model: 'test', decision: {
    action: 'rebalance' as const, band: 'wide' as const, confidence: 'high' as const, reason: 'Reopen near the current price.' } }));
  return { db, chain, writes, decide, deps: { db, chain, now, deciders: { primary: { provider: 'kimi' as const, model: 'test', decide } } } };
}
beforeEach(() => {
  vi.clearAllMocks();
  chainMocks.position.mockResolvedValue({ pool, tokenId: 7n, liquidity: 100_000_000n, tickLower: -1200, tickUpper: 1200 });
  chainMocks.mon.mockResolvedValue(0.03); chainMocks.fees.mockResolvedValue({ amount0: 100_000n, amount1: 100_000n });
});
describe('Monad watcher', () => {
  it.each(['uniswap-v3', 'uniswap-v4'])('creates an ask-first proposal for %s using a safe-block position', async venue => {
    const f = fixture({ venue }); chainMocks.position.mockResolvedValue({ pool: { ...pool, venue }, tokenId: 7n, liquidity: 100_000_000n, tickLower: -1200, tickUpper: 1200 });
    const result = await watchWallet('w', { memories: {} }, f.deps);
    expect(result.start).toBeUndefined(); expect(f.writes[0].args).toContain('proposed');
    expect(chainMocks.position).toHaveBeenCalledWith(expect.objectContaining({ tokenId: 7n, blockNumber: 100n }));
    expect(f.decide.mock.calls[0]).toBeDefined();
  });
  it('starts autopilot at the saved preset and carries venue and position identity', async () => {
    const f = fixture({ mode: 'autopilot' }); const result = await watchWallet('w', { memories: {} }, f.deps);
    expect(result.start).toMatchObject({ venue: 'uniswap-v3', tokenId: '7', band: 'balanced', walletId: 'w' });
  });
  it('allows the model-selected range only for an agent-band mandate', async () => {
    const f = fixture({ mode: 'autopilot', band: 'agent' });
    expect((await watchWallet('w', { memories: {} }, f.deps)).start?.band).toBe('wide');
  });
  it('model failure and missing credentials leave positions unchanged', async () => {
    const f = fixture(); f.decide.mockRejectedValue(new Error('provider unavailable'));
    await watchWallet('w', { memories: {} }, f.deps); expect(f.writes).toHaveLength(0);
    await watchWallet('w', { memories: {} }, { ...f.deps, deciders: null }); expect(f.writes).toHaveLength(0);
  });
  it('budget exhaustion consumes no decision and creates no run', async () => {
    const f = fixture(); await watchWallet('w', { memories: {} }, { ...f.deps, reserveCall: async () => false });
    expect(f.decide).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
  });
  it('respects cooldown and daily run limits', async () => {
    const f = fixture(); const first = await watchWallet('w', { memories: {} }, f.deps);
    await watchWallet('w', first.state, { ...f.deps, now: now + 5 * 60_000 }); expect(f.decide).toHaveBeenCalledTimes(1);
    const limited = fixture({ runs: 2 }); await watchWallet('w', { memories: {} }, limited.deps); expect(limited.decide).not.toHaveBeenCalled();
  });
  it('never expires an old running row just because polling or recording took too long', async () => {
    const f = fixture({ open: true }); await watchWallet('w', { memories: {} }, f.deps);
    expect(f.decide).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
  });
  it('does not watch external NFTs, paused wallets, or unavailable valuations', async () => {
    const external = fixture({ minted: false }); await watchWallet('w', { memories: {} }, external.deps); expect(external.decide).not.toHaveBeenCalled();
    const paused = fixture({ paused: true }); expect((await watchWallet('w', { memories: {} }, paused.deps)).stop).toBe(true);
    const missing = fixture(); chainMocks.mon.mockResolvedValue(null); await watchWallet('w', { memories: {} }, missing.deps); expect(missing.decide).not.toHaveBeenCalled();
  });
  it('does not close first when the mandate cannot cover reopening', async () => {
    const f = fixture({ limit: 1, mode: 'autopilot' }); expect((await watchWallet('w', { memories: {} }, f.deps)).start).toBeUndefined();
  });
  it('reserves the shared budget atomically by UTC day; zero disables it', async () => {
    const f = fixture(); expect(await reserveModelCall(f.db, now, 100)).toBe(true);
    expect(await reserveModelCall(f.db, now, 0)).toBe(false);
  });
});
