import { decodeAbiParameters, decodeFunctionData, parseAbi, type Hex } from 'viem';
import { positionUsd, type TokenAmounts } from './position-value';
import { MIN_PAIR_DEPTH_USD, pairDepthUsd, usdPerToken } from './depth';
import type { MonadV3Pool } from './pair-pool';
import type { MonadV4Pool } from './monad-v4-pool';

export type AutomationPool = MonadV3Pool | MonadV4Pool;
/** Execution valuations deliberately use only a verified pool's anchor, never display-price routes. */
export function automationValue(pool: AutomationPool, amounts: TokenAmounts, monUsd: number | null): number | null {
  const depth = pairDepthUsd({ ...pool, sqrtPriceX96: pool.sqrtPriceX96.toString(),
    liquidity: pool.liquidity.toString() }, monUsd);
  if (depth === null || !Number.isFinite(depth) || depth < MIN_PAIR_DEPTH_USD) return null;
  const price = (Number(pool.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (pool.token0.decimals - pool.token1.decimals);
  const value = positionUsd({ ...pool, priceToken1PerToken0: price }, amounts, monUsd);
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

export function anchorSide(pool: AutomationPool, monUsd: number | null): 0 | 1 | null {
  if (usdPerToken(pool.token1.address, monUsd) !== null) return 1;
  if (usdPerToken(pool.token0.address, monUsd) !== null) return 0;
  return null;
}


/** Minimum principal guaranteed by the actual withdrawal calldata, excluding optional fees. */
export function withdrawalMinimums(venue: 'uniswap-v3' | 'uniswap-v4', data: Hex): TokenAmounts {
  if (venue === 'uniswap-v3') {
    const abi = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)',
      'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256,uint256)']);
    const call = decodeFunctionData({ abi, data });
    const calls = call.functionName === 'multicall' ? call.args[0] : [data];
    for (const encoded of calls) {
      try {
        const inner = decodeFunctionData({ abi, data: encoded });
        if (inner.functionName === 'decreaseLiquidity') return { amount0: inner.args[0].amount0Min, amount1: inner.args[0].amount1Min };
      } catch { /* Other collect/burn calls have no minimum principal. */ }
    }
  } else {
    const call = decodeFunctionData({ abi: parseAbi(['function modifyLiquidities(bytes unlockData,uint256 deadline) payable']), data });
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], call.args[0]);
    for (let i = 0; i < params.length; i++) {
      if (actions.slice(2 + i * 2, 4 + i * 2) !== '03') continue;
      const [, amount0, amount1] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], params[i]);
      return { amount0, amount1 };
    }
  }
  throw new Error('WITHDRAWAL_MINIMUMS_UNAVAILABLE');
}
