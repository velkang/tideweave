import { storeIntent } from '../src/intent-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { hashOpaqueValue, type AuthStore } from '../src/auth';
import { createApp, type Bindings } from '../src';
const position = vi.hoisted(() => vi.fn());
vi.mock('../src/automation-position', () => ({ automationPosition: position }));
const owner = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const now = 2_000_000_000_000;
const databases: DatabaseSync[] = [];
beforeEach(() => { position.mockReset(); position.mockResolvedValue({ valueUsd: 10 }); });
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
async function setup() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.exec(`INSERT INTO users(id,owner_address,owner_verified_at,created_at) VALUES ('u1','${owner}',1,1),('u2','0x3333333333333333333333333333333333333333',1,1);
    INSERT INTO managed_wallets(id,user_id,owner_address_at_creation,address,state,created_at,updated_at,dynamic_wallet_id)
    VALUES ('w1','u1','${owner}','${owner}','active',1,1,'d1'),('w2','u2','x','0x3333333333333333333333333333333333333333','active',1,1,'d2');`);
  const db = { prepare(sql: string) { let args: unknown[] = []; return { bind(...values: unknown[]) { args = values; return this },
    async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null },
    async all() { return { results: sqlite.prepare(sql).all(...args as never[]) } },
    async run() { const result = sqlite.prepare(sql).run(...args as never[]); return { meta: { changes: Number(result.changes) } } } } },
    async batch(statements: Array<{ run(): Promise<unknown> }>) { sqlite.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result } catch (error) { sqlite.exec('ROLLBACK'); throw error } },
  } as unknown as D1Database;
  const hashes = new Map([[await hashOpaqueValue('session1'), 'u1'], [await hashOpaqueValue('session2'), 'u2']]);
  const auth = { findSessionUser: async (hash: string) => hashes.has(hash) ? { id: hashes.get(hash), ownerAddress: owner } : null } as unknown as AuthStore;
  const signer = vi.fn(async () => Response.json({ status: 'confirmed' }));
  const starts = vi.fn(async (_request: Request) => Response.json({ started: true }, { status: 202 }));
  const app = createApp({ limitRequest: async () => true, now: () => now, createAuthStore: () => auth });
  const env = { DB: db, AUTH_URI: 'http://localhost:8787', AGENT_SECRET: 'test-secret', SIGNER: { fetch: signer }, AUTOMATION: { fetch: starts } } as unknown as Bindings;
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers = { cookie: 'tideweave_session=session1' } as Record<string,string>) =>
    app.request(path, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const mandate = (status = 'active') => sqlite.prepare(`INSERT INTO automation_mandates(id,wallet_id,pool_id,venue,token_id,mode,status,band,max_position_usd,max_runs_per_day,created_at,updated_at) VALUES ('m1','w1',?,'uniswap-v3','7','ask',?,'balanced',100,2,?,?)`).run(pool,status,now,now);
  const run = (status = 'running') => sqlite.prepare(`INSERT INTO automation_runs(id,mandate_id,wallet_id,token_id,kind,status,band,trigger,created_at,started_at,updated_at) VALUES ('r1','m1','w1','7','rebalance',?,'balanced','user',?,?,?)`).run(status,now,now,now);
  return { sqlite, db, request, signer, starts, mandate, run };
}
const agent = { 'x-tideweave-agent': 'test-secret', 'x-tideweave-run': 'r1' };
describe('Monad automation authorization and APIs', () => {
  it('saves a position-specific mandate and wakes this project’s Worker', async () => {
    const f = await setup(); const response = await f.request('/v1/automation/mandates', { venue: 'uniswap-v3', pairId: pool, tokenId: '7', mode: 'ask', band: 'balanced', maxPositionUsd: 100, maxRunsPerDay: 1 }, 'PUT');
    expect(response.status).toBe(200); expect((await response.json() as { mandate: unknown }).mandate).toMatchObject({ venue: 'uniswap-v3', tokenId: '7', poolId: pool });
    expect(position).toHaveBeenCalled(); expect(f.starts).toHaveBeenCalledTimes(1);
  });
  it('one-off rebalance carries wallet, venue, and position into the runner', async () => {
    const f = await setup(); const response = await f.request('/v1/automation/runs', { venue: 'uniswap-v3', pairId: pool, tokenId: '7', band: 'balanced' });
    expect(response.status).toBe(201); const row = f.sqlite.prepare('SELECT wallet_id,token_id,status FROM automation_runs').get();
    expect(row).toMatchObject({ wallet_id: 'w1', token_id: '7', status: 'running' });
    expect(JSON.parse(await f.starts.mock.calls[0][0].text())).toMatchObject({ venue: 'uniswap-v3', tokenId: '7', walletId: 'w1' });
  });
  it('refuses cross-user proposal approval', async () => {
    const f = await setup(); f.mandate(); f.run('proposed');
    expect((await f.request('/v1/automation/runs/r1/approve', {}, 'POST', { cookie: 'tideweave_session=session2' })).status).toBe(404);
    expect(f.starts).not.toHaveBeenCalled();
  });
  it('rechecks valuation and range on proposal approval', async () => {
    const f = await setup(); f.mandate(); f.run('proposed'); position.mockResolvedValue({ valueUsd: 1000 });
    const response = await f.request('/v1/automation/runs/r1/approve', {}); expect(response.status).toBe(409); expect(f.starts).not.toHaveBeenCalled();
  });
  it('enforces the daily execution limit before starting', async () => {
    const f = await setup(); f.mandate(); f.run('proposed');
    f.sqlite.exec(`INSERT INTO automation_runs(id,mandate_id,wallet_id,kind,status,trigger,created_at,started_at,updated_at) VALUES ('a','m1','w1','close','done','user',${now},${now},${now}),('b','m1','w1','close','done','user',${now},${now},${now});`);
    expect((await f.request('/v1/automation/runs/r1/approve', {})).status).toBe(409); expect(f.starts).not.toHaveBeenCalled();
  });
  it('permits read-only status but blocks manual submission while a run owns the wallet', async () => {
    const f = await setup(); f.mandate(); f.run();
    expect((await f.request('/v1/automation/runs')).status).toBe(200);
    expect(await (await f.request('/v1/wallets/v3/approvals/prepare', {})).json()).toEqual({ error: 'AUTOMATION_RUNNING' });
  });
  it('refuses agents outside their pool, position, venue, or route', async () => {
    const f = await setup(); f.mandate(); f.run();
    expect((await f.request('/v1/wallets/v3/positions/actions/prepare', { tokenId: '8', action: 'withdraw' }, 'POST', agent)).status).toBe(403);
    expect((await f.request('/v1/wallets/swaps/quote', { venue: 'nadfun-v2', pairId: pool }, 'POST', agent)).status).toBe(403);
    expect((await f.request('/v1/wallets/provision', {}, 'POST', agent)).status).toBe(403);
  });
  it('keeps reconciliation available after revoking but refuses another execute', async () => {
    const f = await setup(); f.mandate('revoked'); f.run();
    f.sqlite.exec(`INSERT INTO wallet_intents(id,wallet_id,kind,payload_hash,status,expires_at,created_at,updated_at,automation_run_id) VALUES ('i1','w1','monad_swap','hash','submitted',1,1,1,'r1');
      INSERT INTO mainnet_transaction_attempts(id,intent_id,wallet_id,nonce,transaction_hash,status,submitted_at,chain_id) VALUES ('a1','i1','w1',0,'0x01','submitted',1,143);`);
    expect((await f.request('/v1/wallets/attempts/a1/reconcile', {}, 'POST', agent)).status).toBe(200);
    expect((await f.request('/v1/wallets/intents/i1/execute', {}, 'POST', agent)).status).toBe(403);
    expect((await f.request('/v1/wallets/intents/i1/attempt', undefined, 'GET', agent)).status).toBe(200);
  });
  it('scopes ambiguous execution lookups to the run and owner', async () => {
    const f = await setup(); f.mandate(); f.run(); f.sqlite.exec(`INSERT INTO wallet_intents(id,wallet_id,kind,payload_hash,status,expires_at,created_at,updated_at) VALUES ('manual','w1','monad_swap','hash','pending',1,1,1);`);
    expect((await f.request('/v1/wallets/intents/manual/attempt', undefined, 'GET', agent)).status).toBe(404);
    expect((await f.request('/v1/wallets/intents/manual/attempt')).status).toBe(200);
    expect((await f.request('/v1/wallets/intents/manual/attempt', undefined, 'GET', { cookie: 'tideweave_session=session2' })).status).toBe(404);
  });
  it('database uniqueness prevents two running runs for different mandates on one wallet', async () => {
    const f = await setup(); f.mandate(); f.run();
    f.sqlite.exec(`INSERT INTO automation_mandates(id,wallet_id,pool_id,mode,status,band,max_position_usd,max_runs_per_day,created_at,updated_at) VALUES ('m2','w1','other','ask','active','balanced',100,1,1,1);`);
    expect(() => f.sqlite.exec(`INSERT INTO automation_runs(id,mandate_id,wallet_id,kind,status,trigger,created_at,updated_at) VALUES ('r2','m2','w1','close','running','user',1,1);`)).toThrow();
  });
  it('stores run association atomically and scopes idempotency keys by run', async () => {
    const f = await setup(); f.mandate(); f.run('proposed');
    f.sqlite.exec(`CREATE TABLE test_details(intent_id TEXT REFERENCES wallet_intents(id), created_at INTEGER);
      INSERT INTO automation_runs(id,mandate_id,wallet_id,kind,status,trigger,created_at,updated_at) VALUES ('r2','m1','w1','close','done','user',1,1);`);
    const input = { walletId: 'w1', kind: 'test_kind', payloadHash: '0x01' as const, idempotencyKey: 'same-key', now,
      expiresAt: now + 1000, table: 'test_details', row: {} };
    const first = await storeIntent(f.db, { ...input, automationRunId: 'r1' });
    const replay = await storeIntent(f.db, { ...input, automationRunId: 'r1' });
    const other = await storeIntent(f.db, { ...input, automationRunId: 'r2' });
    expect(first.intentId).toBe(replay.intentId); expect(replay.replayed).toBe(true); expect(other.intentId).not.toBe(first.intentId);
    expect(f.sqlite.prepare('SELECT automation_run_id FROM wallet_intents WHERE id = ?').get(first.intentId)).toMatchObject({ automation_run_id: 'r1' });
  });

});
