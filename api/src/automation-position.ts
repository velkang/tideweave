import { amountsForLiquidity, automationValue, readMonUsd, readMonadV3Position, readMonadV4Position,
  readV3Fees, readV4Fees, type MonadV3PoolClient, type FeeCallClient } from '@tideweave/chain';
import type { Address } from 'viem';
import { AuthError } from './auth';

export type AutomationVenue = 'uniswap-v3' | 'uniswap-v4';
export type AutomationClient = MonadV3PoolClient & FeeCallClient & {
  getBlock(input: { blockTag: 'safe' }): Promise<{ number: bigint | null }>;
};
export async function automationPosition(db: D1Database, client: AutomationClient, wallet: { id: string; address: Address },
  venue: AutomationVenue, poolId: string, tokenId: string) {
  const table = venue === 'uniswap-v3' ? 'mint_intents' : 'monad_v4_mint_intents';
  const minted = await db.prepare(`SELECT wi.id FROM wallet_intents wi JOIN ${table} mi ON mi.intent_id = wi.id
    WHERE wi.wallet_id = ?1 AND wi.kind = ?2 AND wi.status = 'confirmed' AND mi.token_id = ?3 LIMIT 1`)
    .bind(wallet.id, venue === 'uniswap-v3' ? 'monad_v3_mint' : 'monad_v4_mint', tokenId).first();
  if (!minted) throw new AuthError('POSITION_NOT_OWNED', 404);
  const block = await client.getBlock({ blockTag: 'safe' });
  if (block.number === null) throw new AuthError('SAFE_BLOCK_UNAVAILABLE', 503);
  const read = venue === 'uniswap-v3' ? readMonadV3Position : readMonadV4Position;
  const position = await read({ client, owner: wallet.address, tokenId: BigInt(tokenId), blockNumber: block.number })
    .catch(error => { throw new AuthError(error instanceof Error && /not owned/i.test(error.message)
      ? 'POSITION_NOT_OWNED' : 'POSITION_READ_UNAVAILABLE', error instanceof Error && /not owned/i.test(error.message) ? 404 : 503) });
  if (position.pool.id.toLowerCase() !== poolId.toLowerCase()) throw new AuthError('POSITION_POOL_MISMATCH', 422);
  const directory = venue === 'uniswap-v3' ? 'monad_v3_pool_directory' : 'monad_v4_pool_directory';
  const column = venue === 'uniswap-v3' ? 'pool_address' : 'pool_id';
  if (!await db.prepare(`SELECT ${column} FROM ${directory} WHERE ${column} = ?1`).bind(poolId).first()) {
    throw new AuthError('POOL_NOT_ELIGIBLE', 422);
  }
  if (position.liquidity <= 0n) throw new AuthError('POSITION_EMPTY', 422);
  const monUsd = await readMonUsd(client, block.number).catch(() => null);
  const fees = venue === 'uniswap-v3'
    ? await readV3Fees({ client, tokenId: position.tokenId, owner: wallet.address, blockNumber: block.number })
    : await readV4Fees({ client, poolId: position.pool.id as `0x${string}`, tokenId: position.tokenId,
      tickLower: position.tickLower, tickUpper: position.tickUpper, blockNumber: block.number });
  const amounts = amountsForLiquidity({ ...position, sqrtPriceX96: position.pool.sqrtPriceX96 });
  const valueUsd = automationValue(position.pool, { amount0: amounts.amount0 + fees.amount0,
    amount1: amounts.amount1 + fees.amount1 }, monUsd);
  if (valueUsd === null) throw new AuthError('AUTOMATION_VALUATION_UNAVAILABLE', 422);
  return { position, amounts, fees, valueUsd, monUsd, blockNumber: block.number };
}
