import { concat, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_DELEGATED_RESERVE, MONAD_TOKENS, SIMPLE_7702_ACCOUNT, type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const meme = getAddress("0x7777777777777777777777777777777777777777");
const env = { DB: {} as D1Database, AUTH_URI: "http://localhost:5173" } as Bindings;
const ONE = 10n ** 18n;

async function session() {
  const token = `wallet-session-${Math.random()}`;
  const hash = await hashOpaqueValue(token);
  const authStore = { findSessionUser: async (given: string) => given === hash
    ? { id: "user-1", ownerAddress: wallet } : null } as unknown as AuthStore;
  return { authStore, headers: { cookie: `tideweave_session=${token}` } };
}

function database(usedTokens: Address[]) {
  const sql: string[] = [];
  const db = { prepare(statement: string) {
    sql.push(statement);
    return { bind() { return this; },
      async first() { return statement.includes("managed_wallets") ? { id: "wallet-1", address: wallet } : null; },
      async all() { return { results: usedTokens.map((token) => ({ token })) }; } };
  } } as unknown as D1Database;
  return { db, sql };
}

function chain(options: { code?: Hex; balances: Record<string, bigint>; mon: bigint }) {
  const metadata: Record<string, [string, number]> = { [MONAD_TOKENS.WMON]: ["WMON", 18], [MONAD_TOKENS.USDC]: ["USDC", 6],
    [MONAD_TOKENS.USDT0]: ["USDT0", 6], [MONAD_TOKENS.AUSD]: ["AUSD", 6], [MONAD_TOKENS.WETH]: ["WETH", 18],
    [MONAD_TOKENS.WBTC]: ["WBTC", 8], [meme]: ["MEME", 18] };
  return {
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getBalance: async () => options.mon,
    getCode: async ({ address }: { address: Address }) => address === wallet ? options.code : "0x6000",
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === "balanceOf") return options.balances[address] ?? 0n;
      const [symbol, decimals] = metadata[address] ?? [];
      if (functionName === "symbol") return symbol;
      if (functionName === "decimals") return decimals;
      throw new Error(`Unexpected ${functionName} on ${address}`);
    },
  } as unknown as MonadV3PoolClient;
}

describe("the managed wallet's balances", () => {
  it("lists MON and every held token, known and used, with dollar values where priced", async () => {
    const { authStore, headers } = await session();
    const { db, sql } = database([meme]);
    const app = createApp({ limitRequest: async () => true, createAuthStore: () => authStore, monUsd: async () => 0.03,
      createMonadClient: () => chain({ mon: 20n * ONE, balances: { [MONAD_TOKENS.USDC]: 2_500_000n,
        [MONAD_TOKENS.WMON]: 100n * ONE, [meme]: 7n * ONE } }) });
    const response = await app.request("/v1/wallets/balances", { headers }, { ...env, DB: db });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ address: wallet, delegate: null, reserve: "0",
      mon: { balance: (20n * ONE).toString(), usd: 0.6 } });
    // Held tokens only, most valuable first; a token without a known price comes last.
    expect(body.tokens).toEqual([
      { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18, balance: (100n * ONE).toString(), usd: 3 },
      { address: MONAD_TOKENS.USDC, symbol: "USDC", decimals: 6, balance: "2500000", usd: 2.5 },
      { address: meme, symbol: "MEME", decimals: 18, balance: (7n * ONE).toString(), usd: null },
    ]);
    expect(body.unpricedAssetCount).toBe(1);
    expect(body.totalUsd).toBeCloseTo(6.1, 9);
    // D1 refuses a compound SELECT with many terms, so each table is read on its own.
    const reads = sql.filter((statement) => statement.includes("wallet_intents"));
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((statement) => !/\bUNION\b/i.test(statement))).toBe(true);
  });

  it("shows the 10 MON a nad.fun-delegated wallet must keep", async () => {
    const { authStore, headers } = await session();
    const { db } = database([]);
    const app = createApp({ limitRequest: async () => true, createAuthStore: () => authStore, monUsd: async () => null,
      createMonadClient: () => chain({ mon: 12n * ONE, balances: {}, code: concat(["0xef0100", SIMPLE_7702_ACCOUNT]) }) });
    const body = await (await app.request("/v1/wallets/balances", { headers }, { ...env, DB: db })).json();
    expect(body).toMatchObject({ delegate: SIMPLE_7702_ACCOUNT, reserve: MONAD_DELEGATED_RESERVE.toString(),
      mon: { balance: (12n * ONE).toString(), usd: null }, tokens: [], totalUsd: 0, unpricedAssetCount: 1 });
  });

  it("needs a signed-in user with a wallet", async () => {
    const app = createApp({ limitRequest: async () => true, createAuthStore: () => ({ findSessionUser: async () => null }) as unknown as AuthStore });
    expect((await app.request("/v1/wallets/balances", {}, env)).status).toBe(401);
  });

  it.each([
    { mon: 0n, balances: { [MONAD_TOKENS.USDC]: 2_500_000n }, used: [], unpriced: 0, total: 2.5 },
    { mon: ONE, balances: { [meme]: ONE }, used: [meme], unpriced: 2, total: 0 },
    { mon: 0n, balances: {}, used: [], unpriced: 0, total: 0 },
  ])("counts only held unpriced assets ($unpriced)", async ({ mon, balances, used, unpriced, total }) => {
    const { authStore, headers } = await session();
    const { db } = database(used);
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      monUsd: async () => null, createMonadClient: () => chain({ mon, balances }) })
      .request("/v1/wallets/balances", { headers }, { ...env, DB: db });
    expect(await response.json()).toMatchObject({ unpricedAssetCount: unpriced, totalUsd: total });
  });
});
