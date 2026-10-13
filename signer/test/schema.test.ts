import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { D1MainnetEvaluationStore } from '../src/mainnet-evaluation-store';
import { UNISWAP_V3_MONAD, UNISWAP_V4_MONAD } from '@tideweave/chain';
const migrations = new URL('../../api/migrations/', import.meta.url);
const schema = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(name, migrations), 'utf8')).join('\n');
const address = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const hash = `0x${'11'.repeat(32)}`;
const instances: DatabaseSync[] = [];
function database() {
  const db = new DatabaseSync(':memory:'); instances.push(db);
  db.exec(schema);
  return db;
}
afterEach(() => { instances.splice(0).forEach(db => db.close()); });
function insert(db: DatabaseSync, table: string, supplied: Record<string,string|number|null>) {
  const values: Record<string,string|number|null> = { ...supplied };
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
  for (const column of columns) {
    if (!(column.name in values) && column.notnull && column.dflt_value === null) {
      values[column.name] = column.type === 'INTEGER' ? 1 : /address|recipient|currency|spender|target|manager/.test(column.name) ? address : '1';
    }
  }
  const names = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(values));
}
function owned(db: DatabaseSync) {
  insert(db, 'users', { id: 'u', owner_address: address });
  insert(db, 'managed_wallets', { id: 'w', user_id: 'u', address, owner_address_at_creation: address, state: 'active', dynamic_wallet_id: 'dynamic-w' });
}
function d1(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let args: Array<string|number|null> = []; return { bind(...values: Array<string|number|null>) { args = values; return this },
    async first() { return db.prepare(sql).get(...args) ?? null }, async all() { return { results: db.prepare(sql).all(...args) } },
    async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } } },
  } } } as unknown as D1Database;
}
describe('clean Monad baseline', () => {
  it('creates the Monad schema with valid foreign keys and rejects unsupported chains', () => {
    const db = database();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining(["managed_wallets", "wallet_intents", "automation_runs", "monad_v3_pool_directory", "monad_v4_pool_directory", "monad_nadfun_pair_directory"]));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    owned(db);
    insert(db, 'wallet_intents', { id: 'i', wallet_id: 'w', kind: 'monad_swap', status: 'pending', payload_hash: hash, expires_at: 1 });
    expect(() => insert(db, 'mainnet_transaction_attempts', { id: 'a', intent_id: 'i', wallet_id: 'w', nonce: 0,
      transaction_hash: hash, status: 'submitted', chain_id: 1 })).toThrow();
  });
  const cases = [
    ['monad_v3_approval', 'approval_intents', { chain_id: 143, token_symbol: 'TOKEN', token_address: token, pool_address: address, spender: UNISWAP_V3_MONAD.nonfungiblePositionManager }],
    ['monad_v3_mint', 'mint_intents', { chain_id: 143, pool_address: address, token0_address: address, token1_address: token, fee: 3000, tick_spacing: 60, position_manager: UNISWAP_V3_MONAD.nonfungiblePositionManager }],
    ['monad_v3_position_withdraw', 'position_action_intents', { chain_id: 143, action: 'withdraw', token_id: '7', position_manager: UNISWAP_V3_MONAD.nonfungiblePositionManager, constraints_json: JSON.stringify({ poolAddress: address, expected0: '1', expected1: '2' }) }],
    ['monad_v4_approval', 'monad_v4_approval_intents', { pool_id: hash, currency0: address, currency1: token, hooks: '0x0000000000000000000000000000000000000000', token: token, stage: 'erc20', target: UNISWAP_V4_MONAD.permit2 }],
    ['monad_v4_mint', 'monad_v4_mint_intents', { pool_id: hash, currency0: address, currency1: token, hooks: '0x0000000000000000000000000000000000000000', value: '0' }],
    ['monad_v4_position_withdraw', 'monad_v4_position_action_intents', { action: 'withdraw', pool_id: hash, token_id: '7', remove_bps: 10000 }],
    ['monad_swap', 'monad_swap_intents', { venue: 'uniswap-v3', pair_id: address, token_in: address, token_out: token, native_value: '0' }],
    ['monad_swap_approval', 'monad_swap_approval_intents', { venue: 'uniswap-v3', pair_id: address, token: token, stage: 'erc20' }],
    ['monad_nadfun_add', 'monad_nadfun_intents', { action: 'add', pair_address: address, token0_address: address, token1_address: token, meme_token: token, reserve0: '1', reserve1: '1', total_supply: '1', token0_decimals: 18, token1_decimals: 18 }],
    ['monad_withdrawal', 'monad_withdrawal_intents', { chain_id: 143, recipient: token, target_address: token, native_value: '1', asset_address: '0x0000000000000000000000000000000000000000', nonce: hash, expires_at: 2000000600 }],
  ] as const;
  it.each(cases)('loads %s against the current schema', async (kind, table, detail) => {
    const db = database(); owned(db);
    insert(db, 'wallet_intents', { id: 'i', wallet_id: 'w', kind, status: 'pending', payload_hash: hash, expires_at: 2000000600000 });
    insert(db, table, { intent_id: 'i', calldata: '0x', ...detail });
    const loaded = await new D1MainnetEvaluationStore(d1(db)).load('i');
    expect(loaded).toMatchObject({ kind, intentId: 'i', transaction: { chainId: 143 }, custody: { dynamicWalletId: 'dynamic-w' } });
  });
  it('fails safely if the fresh baseline is applied over an existing database', () => {
    const db = database(); owned(db);
    expect(() => db.exec(schema)).toThrow();
    expect(db.prepare('SELECT address FROM managed_wallets').get()).toMatchObject({ address });
  });
});
