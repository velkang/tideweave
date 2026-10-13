import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { automationValue, anchorSide, withdrawalMinimums, buildMonadV3FullWithdrawal, buildMonadV4PositionAction,
  MONAD_TOKENS, monadV4PoolId, type MonadV3Pool, type MonadV4Pool } from '../src';
const token = '0x2222222222222222222222222222222222222222' as const;
const pool: MonadV3Pool = { venue: 'uniswap-v3', chainId: 143, id: token, token0: { address: token, symbol: 'T', decimals: 18 },
  token1: { address: MONAD_TOKENS.USDC, symbol: 'USDC', decimals: 6 }, fee: 3000, tickSpacing: 60,
  sqrtPriceX96: BigInt(Math.floor(2 ** 96 / 1e6)), liquidity: 10n ** 18n, tick: -276324 };
describe('execution-only anchor valuations', () => {
  it('normalizes unequal decimals and reversed sides', () => {
    expect(automationValue(pool, { amount0: 10n ** 18n, amount1: 1_000_000n }, null)).toBeCloseTo(2);
    const reversed = { ...pool, token0: pool.token1, token1: pool.token0, sqrtPriceX96: BigInt(Math.floor(2 ** 96 * 1e6)) };
    expect(automationValue(reversed, { amount0: 1_000_000n, amount1: 10n ** 18n }, null)).toBeCloseTo(2);
    expect(anchorSide(pool, null)).toBe(1);
  });
  it('normalizes native MON and WMON while refusing unavailable MON prices', () => {
    for (const address of [zeroAddress, MONAD_TOKENS.WMON]) {
      const monPool = { ...pool, liquidity: 10n ** 24n, token0: { ...pool.token0, address }, token1: { ...pool.token0, address: token }, sqrtPriceX96: 2n ** 96n };
      expect(automationValue(monPool, { amount0: 10n ** 18n, amount1: 10n ** 18n }, .03)).toBeCloseTo(.06);
      expect(automationValue(monPool, { amount0: 1n, amount1: 1n }, null)).toBeNull();
    }
  });
  it('refuses thin pools and invalid prices', () => {
    expect(automationValue({ ...pool, liquidity: 0n }, { amount0: 1n, amount1: 1n }, null)).toBeNull();
    expect(automationValue({ ...pool, sqrtPriceX96: 0n }, { amount0: 1n, amount1: 1n }, null)).toBeNull();
  });
  it('extracts the actual v3 withdrawal minimum principal', () => {
    const action = buildMonadV3FullWithdrawal({ tokenId: 7n, recipient: token, liquidity: 1000n,
      expected0: 1000n, expected1: 2000n, slippageBps: 100, deadline: 2000000600n });
    expect(withdrawalMinimums('uniswap-v3', action.data)).toEqual({ amount0: 990n, amount1: 1980n });
  });
  it('extracts the v4 burn minima encoded by the existing SDK', () => {
    const key = { currency0: token, currency1: MONAD_TOKENS.USDC, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const v4: MonadV4Pool = { ...pool, venue: 'uniswap-v4', ...key, token0: { ...pool.token0, decimals: 6 },
      id: monadV4PoolId(key), sqrtPriceX96: 2n ** 96n, tick: 0, lpFee: 3000 };
    const action = buildMonadV4PositionAction({ kind: 'withdraw', position: { pool: v4, tokenId: 7n,
      liquidity: 100000000n, tickLower: -1200, tickUpper: 1200 }, recipient: token, slippageBps: 100, deadline: 2000000600n });
    const minimums = withdrawalMinimums('uniswap-v4', action.data);
    expect(minimums.amount0).toBeGreaterThan(0n); expect(minimums.amount1).toBeGreaterThan(0n);
    expect(minimums.amount0).toBeLessThan(6_000_000n);
  });
});
