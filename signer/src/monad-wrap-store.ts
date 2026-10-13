import { MONAD_CHAIN_ID, MONAD_TOKENS, type WrapAction } from "@tideweave/chain";
import type { Hex } from "viem";
import type { LoadedMainnetIntent } from "./mainnet-evaluator";

export type StoredWrap = { action: WrapAction; amount: bigint };

/** Loads a wrap or unwrap and the exact transaction stored with it. */
export async function loadWrapIntent(db: D1Database,
  common: Omit<LoadedMainnetIntent, "transaction">): Promise<LoadedMainnetIntent | null> {
  const row = await db.prepare("SELECT * FROM monad_wrap_intents WHERE intent_id = ?1").bind(common.intentId)
    .first<{ action: WrapAction; amount: string; calldata: Hex; native_value: string }>();
  if (!row) return null;
  return { ...common, transaction: { chainId: MONAD_CHAIN_ID, to: MONAD_TOKENS.WMON,
    data: row.calldata, value: BigInt(row.native_value) }, monadWrap: { action: row.action, amount: BigInt(row.amount) } };
}
