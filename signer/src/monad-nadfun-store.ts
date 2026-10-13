import { MONAD_CHAIN_ID } from "@tideweave/chain";
import { getAddress, type Address, type Hex } from "viem";
import type { LoadedMainnetIntent } from "./mainnet-evaluator";

/** The stored preview a nad.fun batch is rebuilt from. */
export type StoredNadIntent = {
  action: "add" | "remove" | "clear";
  pair?: { address: Address; token0: Address; token1: Address; token0Decimals: number; token1Decimals: number;
    memeToken: Address; reserve0: bigint; reserve1: bigint; totalSupply: bigint };
  amount0Desired?: bigint;
  amount1Desired?: bigint;
  wrapAmount?: bigint;
  lpBefore?: bigint;
  liquidity?: bigint;
  balance0Before?: bigint;
  balance1Before?: bigint;
  slippageBps?: number;
  calldata: Hex;
};

type NadRow = {
  action: "add" | "remove" | "clear"; pair_address: string | null; token0_address: string | null;
  token1_address: string | null; token0_decimals: number | null; token1_decimals: number | null;
  meme_token: string | null; reserve0: string | null; reserve1: string | null; total_supply: string | null;
  amount0_desired: string | null; amount1_desired: string | null; wrap_amount: string | null;
  lp_before: string | null; liquidity: string | null; balance0_before: string | null;
  balance1_before: string | null; slippage_bps: number | null; calldata: Hex;
};

const big = (value: string | null) => value === null ? undefined : BigInt(value);

/** Loads a nad.fun intent's preview; the batch is always sent by the wallet to itself. */
export async function loadNadIntent(db: D1Database,
  common: Omit<LoadedMainnetIntent, "transaction">): Promise<LoadedMainnetIntent | null> {
  const row = await db.prepare("SELECT * FROM monad_nadfun_intents WHERE intent_id = ?1")
    .bind(common.intentId).first<NadRow>();
  if (!row) return null;
  const pair = row.pair_address && row.token0_address && row.token1_address && row.meme_token &&
    row.reserve0 && row.reserve1 && row.total_supply && row.token0_decimals !== null && row.token1_decimals !== null
    ? { address: getAddress(row.pair_address), token0: getAddress(row.token0_address),
      token1: getAddress(row.token1_address), token0Decimals: row.token0_decimals,
      token1Decimals: row.token1_decimals, memeToken: getAddress(row.meme_token), reserve0: BigInt(row.reserve0),
      reserve1: BigInt(row.reserve1), totalSupply: BigInt(row.total_supply) }
    : undefined;
  if (row.action !== "clear" && !pair) return null;
  return { ...common,
    transaction: { chainId: MONAD_CHAIN_ID, to: common.wallet.address, data: row.calldata, value: 0n },
    monadNadfun: { action: row.action, pair, amount0Desired: big(row.amount0_desired),
      amount1Desired: big(row.amount1_desired), wrapAmount: big(row.wrap_amount), lpBefore: big(row.lp_before),
      liquidity: big(row.liquidity), balance0Before: big(row.balance0_before), balance1Before: big(row.balance1_before),
      slippageBps: row.slippage_bps ?? undefined, calldata: row.calldata } };
}
