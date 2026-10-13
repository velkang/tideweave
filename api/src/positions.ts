import { UsdPriceResolver, type ValuationPool } from "./pricing";
import type { Address, Hex } from "viem";
import { amountsForLiquidity, readMonadV3Position, readMonadV4Position, readNadPair, readNadPosition,
  readV3Fees, readV4Fees, type FeeCallClient, type MonadV3PoolClient, type StateViewClient,
  type TokenAmounts } from "@tideweave/chain";

// The wallet's open positions are found from the mints Tideweave confirmed for it, then read
// live: an NFT that has since been burned or transferred is simply left out.

export const POSITION_PAGE = 50;

type MintedRow = { token_id: string; transaction_hash: Hex };

async function mintedTokenIds(db: D1Database, walletId: string, venue: "v3" | "v4", page: number) {
  const sql = venue === "v3"
    ? `SELECT mi.token_id, wi.transaction_hash
       FROM mint_intents mi JOIN wallet_intents wi ON wi.id = mi.intent_id
       WHERE wi.wallet_id = ?1 AND wi.kind = 'monad_v3_mint'
         AND wi.status = 'confirmed' AND mi.token_id IS NOT NULL
       ORDER BY wi.created_at DESC LIMIT ${POSITION_PAGE + 1} OFFSET ?2`
    : `SELECT mi.token_id, wi.transaction_hash
       FROM monad_v4_mint_intents mi JOIN wallet_intents wi ON wi.id = mi.intent_id
       WHERE wi.wallet_id = ?1 AND wi.kind = 'monad_v4_mint'
         AND wi.status = 'confirmed' AND mi.token_id IS NOT NULL
       ORDER BY wi.created_at DESC LIMIT ${POSITION_PAGE + 1} OFFSET ?2`;
  const rows = await db.prepare(sql).bind(walletId, page * POSITION_PAGE).all<MintedRow>();
  return rows.results ?? [];
}

const present = <T>(value: T | null): value is T => value !== null;

export async function listV3Positions(input: { db: D1Database; client: MonadV3PoolClient; walletId: string;
  owner: Address; blockNumber: bigint; page: number }) {
  const rows = await mintedTokenIds(input.db, input.walletId, "v3", input.page);
  const positions = await Promise.all(rows.slice(0, POSITION_PAGE).map(async (row) => {
    try {
      const position = await readMonadV3Position({ client: input.client, owner: input.owner,
        tokenId: BigInt(row.token_id), blockNumber: input.blockNumber });
      return { ...position, transactionHash: row.transaction_hash };
    } catch { return null; }
  }));
  return { positions: positions.filter(present), hasMore: rows.length > POSITION_PAGE };
}

export async function listV4Positions(input: { db: D1Database; client: MonadV3PoolClient; walletId: string;
  owner: Address; blockNumber: bigint; page: number }) {
  const rows = await mintedTokenIds(input.db, input.walletId, "v4", input.page);
  const positions = await Promise.all(rows.slice(0, POSITION_PAGE).map(async (row) => {
    try {
      const position = await readMonadV4Position({ client: input.client, owner: input.owner,
        tokenId: BigInt(row.token_id), blockNumber: input.blockNumber });
      return { ...position, transactionHash: row.transaction_hash };
    } catch { return null; }
  }));
  return { positions: positions.filter(present), hasMore: rows.length > POSITION_PAGE };
}

/** nad.fun LP held in the pairs Tideweave deposited into for this wallet. */
export async function listNadPositions(input: { db: D1Database; client: MonadV3PoolClient; walletId: string;
  owner: Address; blockNumber: bigint }) {
  const rows = await input.db.prepare(
    `SELECT DISTINCT ni.pair_address
     FROM monad_nadfun_intents ni JOIN wallet_intents wi ON wi.id = ni.intent_id
     WHERE wi.wallet_id = ?1 AND wi.kind = 'monad_nadfun_add' AND wi.status = 'confirmed'
     LIMIT ${POSITION_PAGE}`,
  ).bind(input.walletId).all<{ pair_address: Address }>();
  const positions = await Promise.all((rows.results ?? []).map(async (row) => {
    try {
      const pair = await readNadPair({ client: input.client, pairAddress: row.pair_address,
        blockNumber: input.blockNumber, requireActive: false });
      const position = await readNadPosition({ client: input.client, pair, owner: input.owner,
        blockNumber: input.blockNumber });
      return position.lpBalance > 0n ? { pair, ...position } : null;
    } catch { return null; }
  }));
  return positions.filter(present);
}

type ListedPool = ValuationPool & { tick?: number };

export type RangedVenue = "uniswap-v3" | "uniswap-v4";
export type PositionClient = FeeCallClient & StateViewClient;
export type RangedPosition = { tokenId: bigint; pool: ListedPool & { id: Hex | Address; sqrtPriceX96: bigint; tick: number };
  tickLower: number; tickUpper: number; liquidity: bigint };

/**
 * What a v3 or v4 position holds now, the fees it could collect, whether the price is inside its range,
 * and dollar values where a side can be priced. Fees are null when they could not be read.
 */
export async function describeRanged(input: { venue: RangedVenue; position: RangedPosition; client: PositionClient; owner: Address; blockNumber: bigint; pricing: UsdPriceResolver }) {
  const { position } = input;
  const amounts = amountsForLiquidity({ sqrtPriceX96: position.pool.sqrtPriceX96, tickLower: position.tickLower,
    tickUpper: position.tickUpper, liquidity: position.liquidity });
  const fees = await (input.venue === "uniswap-v3"
    ? readV3Fees({ client: input.client, tokenId: position.tokenId, owner: input.owner, blockNumber: input.blockNumber })
    : readV4Fees({ client: input.client, poolId: position.pool.id as Hex, tokenId: position.tokenId,
      tickLower: position.tickLower, tickUpper: position.tickUpper, blockNumber: input.blockNumber }))
    .catch((error: unknown) => { console.warn("Position fees unavailable", position.tokenId, error); return null; });
  return { venue: input.venue, id: position.tokenId.toString(), pool: position.pool,
    range: { tickLower: position.tickLower, tickUpper: position.tickUpper }, liquidity: position.liquidity,
    inRange: position.tickLower <= position.pool.tick && position.pool.tick < position.tickUpper,
    amounts, fees, valueUsd: await input.pricing.value(position.pool, amounts), feesUsd: await input.pricing.value(position.pool, fees) };
}

/** A nad.fun LP balance: its share of each reserve. Fees are added to the reserves, so none are listed apart. */
export async function describeNad(position: { pair: ListedPool & { id: Address }; lpBalance: bigint } & TokenAmounts,
  pricing: UsdPriceResolver) {
  const amounts = { amount0: position.amount0, amount1: position.amount1 };
  return { venue: "nadfun-v2" as const, id: position.pair.id, pool: position.pair, range: null,
    liquidity: position.lpBalance, inRange: true, amounts, fees: null, valueUsd: await pricing.value(position.pair, amounts),
    feesUsd: null };
}
