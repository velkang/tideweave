import { MONAD_CHAIN_ID, type MonadV4PoolKey } from "@tideweave/chain";
import { getAddress, type Address, type Hex } from "viem";
import type { LoadedMainnetIntent } from "./mainnet-evaluator";

type Venue = "uniswap-v3" | "uniswap-v4" | "nadfun-v2";
/** Where a swap or swap approval happens: the pool or pair, and a v4 pool's key. */
export type StoredSwapPair = { venue: Venue; pairId: string; key?: MonadV4PoolKey };
export type StoredSwap = StoredSwapPair & { tokenIn: Address; amountIn: bigint; amountOutMinimum: bigint;
  deadline: bigint };
export type StoredSwapApproval = StoredSwapPair & { token: Address; stage: "erc20" | "permit2"; amount: bigint;
  expiration: bigint };

type PairColumns = { venue: Venue; pair_id: string; currency0: string | null; currency1: string | null;
  fee: number | null; tick_spacing: number | null; hooks: string | null; target: string; calldata: Hex };

function storedPair(row: PairColumns): StoredSwapPair {
  const key = row.venue === "uniswap-v4" && row.currency0 && row.currency1 && row.hooks && row.fee !== null &&
    row.tick_spacing !== null ? { currency0: getAddress(row.currency0), currency1: getAddress(row.currency1),
      fee: row.fee, tickSpacing: row.tick_spacing, hooks: getAddress(row.hooks) } : undefined;
  return { venue: row.venue, pairId: row.pair_id, key };
}

/** Loads a swap or swap approval and the exact transaction stored with it. */
export async function loadSwapIntent(db: D1Database,
  common: Omit<LoadedMainnetIntent, "transaction">): Promise<LoadedMainnetIntent | null> {
  if (common.kind === "monad_swap") {
    const row = await db.prepare("SELECT * FROM monad_swap_intents WHERE intent_id = ?1").bind(common.intentId)
      .first<PairColumns & { token_in: string; amount_in: string; amount_out_minimum: string; deadline: string;
        native_value: string }>();
    if (!row) return null;
    return { ...common, transaction: { chainId: MONAD_CHAIN_ID, to: getAddress(row.target), data: row.calldata,
      value: BigInt(row.native_value) },
    monadSwap: { ...storedPair(row), tokenIn: getAddress(row.token_in), amountIn: BigInt(row.amount_in),
      amountOutMinimum: BigInt(row.amount_out_minimum), deadline: BigInt(row.deadline) } };
  }
  const row = await db.prepare("SELECT * FROM monad_swap_approval_intents WHERE intent_id = ?1").bind(common.intentId)
    .first<PairColumns & { token: string; stage: "erc20" | "permit2"; amount: string; expiration: string }>();
  if (!row) return null;
  return { ...common, transaction: { chainId: MONAD_CHAIN_ID, to: getAddress(row.target), data: row.calldata, value: 0n },
    monadSwapApproval: { ...storedPair(row), token: getAddress(row.token), stage: row.stage,
      amount: BigInt(row.amount), expiration: BigInt(row.expiration) } };
}
