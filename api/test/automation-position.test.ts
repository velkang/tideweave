import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MONAD_TOKENS } from '@tideweave/chain';
import { automationPosition, type AutomationClient } from '../src/automation-position';
const mocks = vi.hoisted(() => ({ position: vi.fn(), price: vi.fn(), fees: vi.fn() }));
vi.mock('@tideweave/chain', async original => ({ ...await original<object>(), readMonadV3Position: mocks.position,
  readMonadV4Position: mocks.position, readMonUsd: mocks.price, readV3Fees: mocks.fees, readV4Fees: mocks.fees }));
const address = '0x2222222222222222222222222222222222222222' as const;
const pool = { chainId: 143, venue: 'uniswap-v3', id: address, token0: { address, symbol: 'T', decimals: 6 },
  token1: { address: MONAD_TOKENS.USDC, symbol: 'USDC', decimals: 6 }, sqrtPriceX96: 2n ** 96n,
  liquidity: 10n ** 12n, tick: 0, tickSpacing: 60, fee: 3000 };
const wallet = { id: 'w', address };
function fixture(minted = true, listed = true, block: bigint | null = 100n) {
  const db = { prepare(sql: string) { return { bind(...args: string[]) { return { async first() {
    return sql.includes('FROM wallet_intents') ? minted && args[0] === wallet.id && args[2] === '7' ? { id: 'i' } : null
      : listed ? { pool_address: address } : null;
  } } } } } } as unknown as D1Database;
  const client = { getBlock: async () => ({ number: block }) } as unknown as AutomationClient;
  return { db, client };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.position.mockResolvedValue({ tokenId: 7n, pool, liquidity: 100_000_000n, tickLower: -1200, tickUpper: 1200 });
  mocks.price.mockResolvedValue(.03); mocks.fees.mockResolvedValue({ amount0: 100_000n, amount1: 100_000n });
});
describe('automation position eligibility', () => {
  it('includes fees, uses safe-block canonical readers, and requires directory membership', async () => {
    const f = fixture(); const value = await automationPosition(f.db, f.client, wallet, 'uniswap-v3', address, '7');
    expect(value.valueUsd).toBeGreaterThan(10); expect(value.blockNumber).toBe(100n);
    expect(mocks.position).toHaveBeenCalledWith(expect.objectContaining({ tokenId: 7n, owner: address, blockNumber: 100n }));
    const missing = fixture(true, false);
    await expect(automationPosition(missing.db, missing.client, wallet, 'uniswap-v3', address, '7')).rejects.toMatchObject({ code: 'POOL_NOT_ELIGIBLE' });
  });
  it('rejects another wallet or an external NFT before RPC work', async () => {
    const f = fixture(); await expect(automationPosition(f.db, f.client, { ...wallet, id: 'other' }, 'uniswap-v3', address, '7')).rejects.toMatchObject({ code: 'POSITION_NOT_OWNED' });
    expect(mocks.position).not.toHaveBeenCalled();
  });
  it('rejects changed pool, empty positions, and missing safe blocks', async () => {
    const f = fixture(); await expect(automationPosition(f.db, f.client, wallet, 'uniswap-v3', '0x3333333333333333333333333333333333333333', '7')).rejects.toMatchObject({ code: 'POSITION_POOL_MISMATCH' });
    mocks.position.mockResolvedValue({ pool, tokenId: 7n, liquidity: 0n });
    await expect(automationPosition(f.db, f.client, wallet, 'uniswap-v3', address, '7')).rejects.toMatchObject({ code: 'POSITION_EMPTY' });
    const missing = fixture(true, true, null); await expect(automationPosition(missing.db, missing.client, wallet, 'uniswap-v3', address, '7')).rejects.toMatchObject({ code: 'SAFE_BLOCK_UNAVAILABLE' });
  });
  it('rejects thin or unanchored positions, while stable anchors remain usable without MON pricing', async () => {
    const f = fixture(); mocks.price.mockResolvedValue(null);
    expect((await automationPosition(f.db, f.client, wallet, 'uniswap-v3', address, '7')).valueUsd).toBeGreaterThan(0);
    mocks.position.mockResolvedValue({ pool: { ...pool, liquidity: 1n }, tokenId: 7n, liquidity: 100n, tickLower: -1200, tickUpper: 1200 });
    await expect(automationPosition(f.db, f.client, wallet, 'uniswap-v3', address, '7')).rejects.toMatchObject({ code: 'AUTOMATION_VALUATION_UNAVAILABLE' });
  });
});
