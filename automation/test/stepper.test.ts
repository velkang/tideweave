import { describe, expect, it, vi } from 'vitest';
import { zeroAddress, type Address } from 'viem';
import { MONAD_TOKENS, monadV4PoolId } from '@tideweave/chain';
import { ApiCallError, type AgentApi, type PoolInfo, type VenueName } from '../src/agent-api';
import { advance, startState, RUN_TIMEOUT_MS, type Outcome, type RunPlan, type RunState } from '../src/stepper';
import { finishRun, WalletAutomation, type AutomationEnv } from '../src/wallet-automation';

const owner = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const now = 2_000_000_000_000;
function fixture(venue: VenueName = 'uniswap-v3', native = false) {
  const pool: PoolInfo = { venue, id: venue === 'uniswap-v3' ? token : `0x${'1'.repeat(64)}`,
    token0: { address: native ? zeroAddress : token, symbol: 'A', decimals: 18 },
    token1: { address: MONAD_TOKENS.USDC, symbol: 'USDC', decimals: 6 }, fee: 3000, tickSpacing: 60,
    sqrtPriceX96: (2n ** 96n).toString(), tick: 0, liquidity: '100000000000000000000', hooks: zeroAddress };
  if (venue === 'uniswap-v4') pool.id = monadV4PoolId({ currency0: pool.token0.address, currency1: pool.token1.address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: zeroAddress });
  const plan: RunPlan = { runId: 'run-1', walletId: 'wallet-1', walletAddress: owner, mandateId: 'mandate-1',
    venue, poolId: pool.id, tokenId: '7', kind: 'rebalance', band: 'balanced', revokeMandate: false };
  const held = [10_000n, 10_000n], allowances = new Map<string, string>(), operations = new Map<string, () => void>();
  let safe = 100, executeCount = 0;
  const prepares: Array<{ operation: string; amount?: string }> = [];
  const prepared = (operation: string, apply: () => void, extra = {}) => {
    const intentId = `intent-${operations.size + 1}`; operations.set(intentId, apply); prepares.push({ operation });
    return { intentId, ...extra };
  };
  const api: AgentApi = {
    pool: async () => pool,
    assets: async () => ({ token0: { balance: String(held[0]) }, token1: { balance: String(held[1]) }, blockNumber: String(safe) }),
    close: async () => prepared('close', () => { held[0] += 1000n; held[1] += 1100n }, { minimum0: '1000', minimum1: '1100' }),
    mint: vi.fn(async (_venue, _id, amounts) => prepared('mint', () => { held[0] -= BigInt(amounts.amount0Desired); held[1] -= BigInt(amounts.amount1Desired) })),
    approveMint: async (_venue, _id, token, amount, stage) => {
      prepares.push({ operation: `approve-${stage}`, amount });
      return prepared(`approve-${stage}`, () => { allowances.set(`${token}:${stage}`, amount) });
    },
    mintAllowances: async () => [pool.token0.address, pool.token1.address].flatMap(token => ['erc20', 'permit2'].map(stage =>
      ({ token, stage: stage as 'erc20' | 'permit2', allowance: allowances.get(`${token}:${stage}`) ?? '0', expiration: String(now / 1000 + 3600) }))),
    quote: async () => ({ amountOutMinimum: '1', approved: true, allowances: [] }),
    approveSwap: async () => prepared('swap-approve', () => {}),
    swap: async (_venue, _id, tokenIn, amount) => prepared('swap', () => {
      const side = tokenIn === pool.token0.address ? 0 : 1; held[side] -= BigInt(amount); held[1 - side] += BigInt(amount);
    }, { minimumOut: amount }),
    execute: async id => { executeCount++; operations.get(id)!(); return { attemptId: id } },
    attempt: async id => ({ status: 'confirmed', attempt: { attemptId: id, status: 'confirmed', transactionHash: '0x01', blockNumber: 100 } }),
    reconcile: async () => ({ status: 'confirmed' }),
  };
  return { api, plan, pool, held, prepares, setSafe: (n: number) => { safe = n }, executions: () => executeCount };
}
async function run(plan: RunPlan, api: AgentApi) {
  let state = startState(plan, now);
  for (let i = 0; i < 80; i++) {
    const result = await advance(state, api, now + i * 1000);
    if (result.kind !== 'wait') return result;
    state = result.state;
  }
  throw new Error('run did not finish');
}
describe('Monad runner', () => {
  it.each(['uniswap-v3', 'uniswap-v4'] as const)('closes and reopens %s with exact approvals and capped proceeds', async venue => {
    const f = fixture(venue);
    // Gifts that arrive after withdrawal never increase the guaranteed reinvestment cap.
    const close = f.api.close;
    f.api.close = async (...args) => { const p = await close(...args); f.held[0] += 5000n; return p };
    expect((await run(f.plan, f.api)).kind).toBe('done');
    expect(f.held[0]).toBeGreaterThanOrEqual(15_000n);
    expect(f.prepares.filter(p => p.amount).every(p => BigInt(p.amount!) <= 1100n)).toBe(true);
    expect(f.prepares.some(p => p.operation === 'mint')).toBe(true);
  });
  it('handles native MON without approving native currency', async () => {
    const f = fixture('uniswap-v4', true);
    expect((await run(f.plan, f.api)).kind).toBe('done');
    expect(f.prepares.filter(p => p.operation === 'approve-erc20')).toHaveLength(2); // record plus prepared step, only USDC
  });
  it('close-only never swaps or reopens', async () => {
    const f = fixture(); expect((await run({ ...f.plan, kind: 'close' }, f.api)).kind).toBe('done');
    expect(f.prepares.map(p => p.operation)).toEqual(['close']);
  });
  it('persists the send marker before execution and recovers a lost response without executing twice', async () => {
    const f = fixture(); let state = startState(f.plan, now);
    state = (await advance(state, f.api, now) as Extract<Outcome, { kind: 'wait' }>).state;
    let persisted: RunState | undefined;
    f.api.execute = vi.fn(async () => { expect(persisted?.pending?.sent).toBe(true); throw new Error('lost response') });
    const first = await advance(state, f.api, now, async s => { persisted = s });
    expect(first.kind).toBe('wait');
    const recovered = await advance(persisted!, f.api, now + 1000);
    expect(recovered.kind).toBe('wait');
    expect(f.api.execute).toHaveBeenCalledTimes(1);
    expect((recovered as Extract<Outcome, { kind: 'wait' }>).state.pending?.attemptId).toBeDefined();
  });
  it('never retries an ambiguous send whose lookup has no attempt yet', async () => {
    const f = fixture(); f.api.attempt = async () => ({ status: 'pending', attempt: null });
    const state = { ...startState(f.plan, now), pending: { step: 'close', intentId: 'unknown', sent: true } };
    expect((await advance(state, f.api, now)).kind).toBe('wait'); expect(f.executions()).toBe(0);
  });
  it('throttled reconciliation preserves pending status and Retry-After', async () => {
    const f = fixture(); f.api.reconcile = async () => { throw new ApiCallError('RATE_LIMITED', 429, 60) };
    const state = { ...startState(f.plan, now), pending: { step: 'close', intentId: 'i', attemptId: 'a' } };
    const result = await advance(state, f.api, now + RUN_TIMEOUT_MS + 1);
    expect(result).toMatchObject({ kind: 'wait', delayMs: 60000, state: { pending: { attemptId: 'a' } } });
  });
  it('follows a replacement attempt without resubmitting or marking the run failed', async () => {
    const f = fixture(); f.api.reconcile = async () => ({ status: 'replaced' });
    const state = { ...startState(f.plan, now), pending: { step: 'close', intentId: 'i', attemptId: 'old' } };
    const result = await advance(state, f.api, now);
    expect(result).toMatchObject({ kind: 'wait', state: { pending: { attemptId: 'i' } } });
    expect(f.executions()).toBe(0);
  });
  it('waits on isolated RPC failures rather than marking a submission failed', async () => {
    const f = fixture(); f.api.reconcile = async () => { throw new Error('RPC down') };
    expect((await advance({ ...startState(f.plan, now), pending: { step: 'close', intentId: 'i', attemptId: 'a' } }, f.api, now)).kind).toBe('wait');
  });
  it('waits until the safe block includes confirmation', async () => {
    const f = fixture(); f.setSafe(99);
    const state = { ...startState(f.plan, now), safeAfter: 100 };
    expect((await advance(state, f.api, now)).kind).toBe('wait'); expect(f.prepares).toHaveLength(0);
  });
  it('keeps confirmed close state when a later step is rejected', async () => {
    const f = fixture(); f.api.pool = async () => { throw new ApiCallError('MANDATE_NOT_ACTIVE', 403) };
    let persisted: RunState | undefined;
    const state = { ...startState(f.plan, now), pending: { step: 'close', intentId: 'i', attemptId: 'a', minimum0: '100', minimum1: '100' } };
    expect(await advance(state, f.api, now, async s => { persisted = s })).toEqual({ kind: 'failed', reason: 'MANDATE_NOT_ACTIVE' });
    expect(persisted?.done).toContain('close');
  });
  it('stops after a definitive reverted transaction', async () => {
    const f = fixture(); f.api.reconcile = async () => ({ status: 'reverted', reasonCode: 'TRANSACTION_REVERTED' });
    expect(await advance({ ...startState(f.plan, now), pending: { step: 'close', intentId: 'i', attemptId: 'a' } }, f.api, now)).toEqual({ kind: 'failed', reason: 'TRANSACTION_REVERTED' });
  });
  it('ends a one-off mandate but preserves a persistent one', async () => {
    const statements: string[] = [];
    const db = { prepare(sql: string) { statements.push(sql); return { bind() { return this } } }, async batch() {} } as unknown as D1Database;
    await finishRun(db, { ...fixture().plan, revokeMandate: true }, { kind: 'failed', reason: 'TEST' }, now);
    expect(statements.some(s => s.includes('revoked'))).toBe(true);
  });
  it('idempotent starts keep the same Durable Object run across restarts', async () => {
    const data = new Map<string, unknown>(); let alarm: number | null = null;
    const storage = { async get(key: string) { return data.get(key) }, async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') data.set(key, value); else Object.entries(key).forEach(([k,v]) => data.set(k,v));
    }, async getAlarm() { return alarm }, async setAlarm(n: number) { alarm = n } };
    const ctx = { storage } as unknown as DurableObjectState;
    const env = {} as AutomationEnv;
    const start = () => new Request('https://automation/start', { method: 'POST', body: JSON.stringify(fixture().plan) });
    expect((await new WalletAutomation(ctx, env).fetch(start())).status).toBe(202);
    expect((await new WalletAutomation(ctx, env).fetch(start())).status).toBe(202);
    const other = new Request('https://automation/start', { method: 'POST', body: JSON.stringify({ ...fixture().plan, runId: 'other' }) });
    expect((await new WalletAutomation(ctx, env).fetch(other)).status).toBe(409);
    expect(alarm).not.toBeNull();
  });
});
