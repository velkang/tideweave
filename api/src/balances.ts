import { formatUnits, getAddress, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { MONAD_TOKENS, readMonadPairToken, type MonadV3PoolClient } from "@tideweave/chain";
import { UsdPriceResolver } from "./pricing";
import { monReserve, walletDelegate } from "./delegation";

// What the managed wallet holds: MON, Monad's main tokens, and every token it has swapped, deposited or
// withdrawn through Tideweave, read live. Tokens it has never touched elsewhere are not searched for.

const MAX_TOKENS = 60;
const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

// One query per token column: D1 refuses a compound SELECT with this many terms.
const USED_TOKEN_COLUMNS: ReadonlyArray<readonly [table: string, column: string, kind?: string]> = [
  ["monad_swap_intents", "token_in"], ["monad_swap_intents", "token_out"],
  ["mint_intents", "token0_address", "monad_v3_mint"], ["mint_intents", "token1_address", "monad_v3_mint"],
  ["monad_v4_mint_intents", "currency0"], ["monad_v4_mint_intents", "currency1"],
  ["monad_nadfun_intents", "token0_address"], ["monad_nadfun_intents", "token1_address"],
  ["monad_withdrawal_intents", "asset_address"],
];

const usedTokenSql = ([table, column, kind]: readonly [string, string, string?]) =>
  `SELECT DISTINCT t.${column} AS token FROM ${table} t JOIN wallet_intents w ON w.id = t.intent_id
   WHERE w.wallet_id = ?1${kind ? ` AND w.kind = '${kind}'` : ""} AND t.${column} IS NOT NULL LIMIT ${MAX_TOKENS}`;

async function walletTokens(db: D1Database, walletId: string): Promise<Address[]> {
  const results = await Promise.all(USED_TOKEN_COLUMNS.map((source) =>
    db.prepare(usedTokenSql(source)).bind(walletId).all<{ token: string }>()));
  const used = results.flatMap((rows) => rows.results ?? []).map((row) => row.token).filter((token) => isAddress(token));
  const all = [...Object.values(MONAD_TOKENS), ...used].map((token) => getAddress(token))
    .filter((token) => token !== zeroAddress);
  return [...new Set(all)].slice(0, MAX_TOKENS);
}

export type BalanceClient = MonadV3PoolClient & {
  getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
};

const usdOf = (amount: bigint, decimals: number, price: number | null) =>
  price === null ? null : Number(formatUnits(amount, decimals)) * price;

/** Live balances at one block, held tokens only, most valuable first and unpriced tokens last. */
export async function readWalletBalances(input: { db: D1Database; client: BalanceClient; walletId: string;
  address: Address; blockNumber: bigint; monUsd: number | null }) {
  const { client, address, blockNumber, monUsd } = input;
  const [tokens, mon, delegate] = await Promise.all([walletTokens(input.db, input.walletId),
    client.getBalance({ address, blockNumber }), walletDelegate(client, address, blockNumber)]);
  const pricing = new UsdPriceResolver(input.db, client, blockNumber, monUsd);
  const read = await Promise.all(tokens.map(async (token) => {
    try {
      const balance = await client.readContract({ address: token, abi: balanceAbi, functionName: "balanceOf",
        args: [address], blockNumber }) as bigint;
      if (balance <= 0n) return null;
      const meta = await readMonadPairToken(client, token, blockNumber);
      return { ...meta, balance: balance.toString(), usd: usdOf(balance, meta.decimals, (await pricing.price(token))?.usd ?? null) };
    } catch (error) {
      console.warn("Token balance unavailable", token, error);
      return null;
    }
  }));
  const held = read.filter((token) => token !== null)
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const monValue = usdOf(mon, 18, monUsd);
  return {
    address, delegate, reserve: monReserve(delegate !== null).toString(),
    mon: { balance: mon.toString(), usd: monValue },
    tokens: held,
    unpricedAssetCount: (mon > 0n && monValue === null ? 1 : 0) + held.filter((token) => token.usd === null).length,
    totalUsd: (monValue ?? 0) + held.reduce((sum, token) => sum + (token.usd ?? 0), 0),
    blockNumber: blockNumber.toString(),
  };
}
