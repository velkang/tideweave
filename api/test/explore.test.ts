import { encodeAbiParameters, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, NADFUN_MONAD, SIMPLE_7702_ACCOUNT, UNISWAP_V3_MONAD, UNISWAP_V4_MONAD,
  amountsForLiquidity, monadV4PoolId, type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const pool = getAddress("0x3333333333333333333333333333333333333333");
const pair = getAddress("0x4444444444444444444444444444444444444444");
const wallet = getAddress("0x5555555555555555555555555555555555555555");
const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");
const meme = getAddress("0x7777777777777777777777777777777777777777");
const v4Key = { currency0: zeroAddress, currency1: token1, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const v4Id = monadV4PoolId(v4Key);
const env = { DB: {} as D1Database, AUTH_URI: "http://localhost:5173" } as Bindings;

type Statement = { sql: string; args: unknown[] };
/** A D1 stand-in: `rows` answers .all() and `first` answers .first() for each statement. */
function database(answer: { rows?: (sql: string) => unknown[]; first?: (sql: string) => unknown }) {
  const statements: Statement[] = [];
  const db = { prepare(sql: string) {
    const statement: Statement = { sql, args: [] };
    statements.push(statement);
    return {
      bind(...args: unknown[]) { statement.args = args; return this; },
      async all() { return { results: answer.rows?.(sql) ?? [] }; },
      async first() { return answer.first?.(sql) ?? null; },
      async run() { return { success: true }; },
    };
  } } as unknown as D1Database;
  return { db, statements };
}

async function session() {
  const token = `explore-session-${Math.random()}`;
  const hash = await hashOpaqueValue(token);
  const authStore = { findSessionUser: async (given: string) => given === hash
    ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
  return { authStore, headers: { cookie: `tideweave_session=${token}` } };
}

const tokenMetadata = (address: Address, functionName: string) => {
  const symbols: Record<string, [string, number]> = { [token0]: ["AAA", 6], [token1]: ["BBB", 24],
    [meme]: ["MEME", 18], [MONAD_TOKENS.WMON]: ["WMON", 18] };
  const [symbol, decimals] = symbols[address] ?? [];
  if (symbol === undefined) return undefined;
  return functionName === "symbol" ? symbol : functionName === "decimals" ? decimals : undefined;
};

/** A chain with one v3 pool (token0/token1), one native-MON v4 pool and one graduated nad.fun pair. */
function chain(options: { code?: Hex; balances?: Record<string, bigint> } = {}) {
  return {
    getCode: async ({ address }: { address: Address }) => address === wallet ? options.code : "0x6000",
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getBalance: async () => 20n * 10n ** 18n,
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
      const metadata = tokenMetadata(address, functionName);
      if (metadata !== undefined) return metadata;
      if (functionName === "balanceOf") return options.balances?.[address] ?? 0n;
      if (functionName === "allowance") return args?.length === 3 ? [0n, 0, 0] : 7n;
      if (address === UNISWAP_V3_MONAD.factory) return pool;
      if (address === UNISWAP_V4_MONAD.stateView) {
        return functionName === "getSlot0" ? [2n ** 96n, 0, 0, 3000] : 500n;
      }
      if (address === NADFUN_MONAD.factory) return pair;
      if (address === NADFUN_MONAD.router) return true;
      if (address === pair) {
        const answers: Record<string, unknown> = { factory: NADFUN_MONAD.factory, token0: MONAD_TOKENS.WMON,
          token1: meme, getReserves: [4_000n, 2_000_000n, 1], totalSupply: 1_000_000n, isLocked: false };
        return answers[functionName];
      }
      if (address === pool) {
        const answers: Record<string, unknown> = { factory: UNISWAP_V3_MONAD.factory, token0, token1, fee: 500,
          tickSpacing: 10, slot0: [2n ** 96n, 0, 0, 0, 0, 0, true], liquidity: 100n };
        return answers[functionName];
      }
      throw new Error(`Unexpected ${functionName} on ${address}`);
    },
  } as unknown as MonadV3PoolClient;
}

const listedRow = (venue: string, id: string, extra: Record<string, unknown> = {}) => ({
  venue, id, token0_address: token0, token0_symbol: "AAA", token0_decimals: 6,
  token1_address: token1, token1_symbol: "BBB", token1_decimals: 24, fee: 500, tick_spacing: 10,
  hooks: null, sqrt_price_x96: (2n ** 96n).toString(), tick: 0, liquidity: "100",
  reserve0: null, reserve1: null, meme_token: null, created_block: 9, updated_at: 123, ...extra,
});

describe("one Explore list across v3, v4 and nad.fun", () => {
  it("lists every venue's pairs in one shape, newest first", async () => {
    const { db, statements } = database({ rows: () => [
      listedRow("uniswap-v3", pool),
      listedRow("uniswap-v4", v4Id, { token0_address: zeroAddress, token0_symbol: "MON", token0_decimals: 18,
        hooks: zeroAddress, fee: 3000, tick_spacing: 60 }),
      listedRow("nadfun-v2", pair, { token0_address: MONAD_TOKENS.WMON, token1_address: meme,
        fee: null, tick_spacing: null, sqrt_price_x96: null, tick: null, reserve0: "4000",
        reserve1: "2000000", meme_token: meme }),
    ] });
    const response = await createApp({ limitRequest: async () => true, createMonadClient: () => chain(), monUsd: async () => null })
      .request("/v1/pairs", {}, { ...env, DB: db });
    expect(response.status).toBe(200);
    const body = await response.json() as { pools: Array<Record<string, unknown>>; nextOffset: number | null };
    expect(body.pools.map((item) => item.venue)).toEqual(["uniswap-v3", "uniswap-v4", "nadfun-v2"]);
    expect(body.pools[2]).toMatchObject({ id: pair, fee: null, reserve0: "4000", memeToken: meme,
      token0: { address: MONAD_TOKENS.WMON } });
    expect(body.pools[0]).toMatchObject({ fee: 500, tickSpacing: 10, token1: { decimals: 24 } });
    expect(body.nextOffset).toBeNull();
    const sql = statements[0].sql;
    for (const table of ["monad_v3_pool_directory", "monad_v4_pool_directory", "monad_nadfun_pair_directory"]) {
      expect(sql).toContain(table);
    }
  });

  it("pages after 25 pairs", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => listedRow("uniswap-v3", `0x${String(index).padStart(40, "0")}`));
    const { db, statements } = database({ rows: () => rows });
    const response = await createApp({ limitRequest: async () => true, createMonadClient: () => chain(), monUsd: async () => null })
      .request("/v1/pairs?offset=25", {}, { ...env, DB: db });
    const body = await response.json() as { pools: unknown[]; nextOffset: number | null };
    expect(body.pools).toHaveLength(25);
    expect(body.nextOffset).toBe(50);
    expect(statements[0].args).toContain(25);
  });

  it("matches a symbol from its start on either side, as an index range", async () => {
    const { db, statements } = database({ rows: () => [] });
    await createApp({ limitRequest: async () => true, createMonadClient: () => chain(), monUsd: async () => null })
      .request("/v1/pairs?q=bb", {}, { ...env, DB: db });
    expect(statements[0].args.slice(0, 2)).toEqual(["bb", "bb\u{10FFFF}"]);
    expect(statements[0].sql).toContain("token1_symbol COLLATE NOCASE >= ?1");
  });

  it("asks the indexer to look a pasted token up before listing its pairs", async () => {
    let discovered = false;
    const { db } = database({ rows: () => discovered ? [listedRow("uniswap-v3", pool)] : [] });
    const indexer = { async fetch(request: Request) {
      expect(await request.json()).toEqual({ tokenAddress: token1 });
      discovered = true;
      return Response.json({ found: 1 });
    } } as Fetcher;
    const response = await createApp({ limitRequest: async () => true, createMonadClient: () => chain(), monUsd: async () => null })
      .request(`/v1/pairs?q=${token1}`, {}, { ...env, DB: db, INDEXER: indexer });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pools: [{ venue: "uniswap-v3", id: pool }] });
  });

  it("reads a pasted pool or pair address from the chain when nothing is listed", async () => {
    const { db } = database({ rows: () => [] });
    const app = createApp({ limitRequest: async () => true, createMonadClient: () => chain(), monUsd: async () => null });
    const v3 = await (await app.request(`/v1/pairs?q=${pool}`, {}, { ...env, DB: db })).json();
    expect(v3).toMatchObject({ pools: [{ venue: "uniswap-v3", id: pool, liquidity: "100" }] });
    const nad = await (await app.request(`/v1/pairs?q=${pair}`, {}, { ...env, DB: db })).json();
    expect(nad).toMatchObject({ pools: [{ venue: "nadfun-v2", id: pair, memeToken: meme, reserve1: "2000000" }] });
  });
});

describe("leaving out almost-empty pairs", () => {
  const usdcPair = (liquidity: string) => listedRow("uniswap-v3", pool, { token0_address: MONAD_TOKENS.USDC,
    token0_decimals: 6, liquidity });

  it("re-reads each listed pair from the chain and hides those a few dollars could move 2%", async () => {
    // Stored with plenty of liquidity, but the chain now holds 100 units: cents of USDC depth.
    const { db } = database({ rows: () => [usdcPair("1000000000000000")] });
    const body = await (await createApp({ limitRequest: async () => true, createMonadClient: () => chain(), monUsd: async () => 1 })
      .request("/v1/pairs", {}, { ...env, DB: db })).json() as { pools: unknown[] };
    expect(body.pools).toEqual([]);
  });

  it("keeps a deep pair, and prices a MON side at the live MON price", async () => {
    const deepChain = { ...chain(), readContract: async (call: { address: Address; functionName: string }) =>
      call.functionName === "liquidity" ? 10n ** 15n : chain().readContract(call as never) } as unknown as MonadV3PoolClient;
    const { db } = database({ rows: () => [usdcPair("1"), listedRow("nadfun-v2", pair, {
      token0_address: MONAD_TOKENS.WMON, token1_address: meme, fee: null, tick_spacing: null,
      sqrt_price_x96: null, tick: null, reserve0: "4000", reserve1: "2000000", meme_token: meme })] });
    const body = await (await createApp({ limitRequest: async () => true, createMonadClient: () => deepChain, monUsd: async () => 0.03 })
      .request("/v1/pairs", {}, { ...env, DB: db })).json() as { pools: Array<{ venue: string }> };
    // The v3 pair now has ~$10M of depth; the nad.fun pair holds 4,000 wei of WMON.
    expect(body.pools.map((item) => item.venue)).toEqual(["uniswap-v3"]);
  });
});

describe("one pair, read live", () => {
  it("resolves v3 and nad.fun from a pool address, without discovering token pools", async () => {
    const app = createApp({ limitRequest: async () => true, createMonadClient: () => chain() });
    for (const [id, venue] of [[pool, "uniswap-v3"], [pair, "nadfun-v2"]]) {
      const response = await app.request(`/v1/pairs/${id}`, {}, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pool: { id, venue } });
    }
    expect((await app.request("/v1/pairs/nope", {}, env)).status).toBe(400);
  });

  it("resolves v4 from its pool ID and rejects an unindexed ID", async () => {
    const app = createApp({ limitRequest: async () => true, createMonadClient: () => chain() });
    const { db } = database({ first: () => ({ currency0: zeroAddress, currency1: token1, fee: 3000,
      tick_spacing: 60, hooks: zeroAddress }) });
    const response = await app.request(`/v1/pairs/${v4Id}`, {}, { ...env, DB: db });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pool: { id: v4Id, venue: "uniswap-v4" } });
    const missing = database({});
    expect((await app.request(`/v1/pairs/${v4Id}`, {}, { ...env, DB: missing.db })).status).toBe(404);
  });

  it("reads a graduated nad.fun pair", async () => {
    const response = await createApp({ limitRequest: async () => true, createMonadClient: () => chain() })
      .request(`/v1/pairs/nadfun-v2/${pair}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pool: { venue: "nadfun-v2", id: pair,
      token0: { address: MONAD_TOKENS.WMON, symbol: "WMON" }, token1: { address: meme },
      reserve0: "4000", totalSupply: "1000000" } });
  });

  it("reads an indexed v4 pool, native MON included", async () => {
    const { db } = database({ first: () => ({ currency0: zeroAddress, currency1: token1, fee: 3000,
      tick_spacing: 60, hooks: zeroAddress }) });
    const response = await createApp({ limitRequest: async () => true, createMonadClient: () => chain() })
      .request(`/v1/pairs/uniswap-v4/${v4Id}`, {}, { ...env, DB: db });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pool: { venue: "uniswap-v4", id: v4Id,
      token0: { address: zeroAddress, symbol: "MON" } } });
  });

  it("rejects an unknown venue or a malformed id", async () => {
    const app = createApp({ limitRequest: async () => true, createMonadClient: () => chain() });
    expect((await app.request(`/v1/pairs/sushiswap/${pool}`, {}, env)).status).toBe(400);
    expect((await app.request("/v1/pairs/nadfun-v2/nope", {}, env)).status).toBe(400);
  });
});

describe("a pair's assets in the managed wallet", () => {
  it("lists balances and no approvals for nad.fun, and reports a 7702 delegation", async () => {
    const { authStore, headers } = await session();
    const { db } = database({ first: () => ({ id: "wallet-1", address: wallet }) });
    const delegated = `0xef0100${SIMPLE_7702_ACCOUNT.slice(2)}` as Hex;
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => chain({ code: delegated, balances: { [meme]: 5n } }) })
      .request(`/v1/wallets/pairs/nadfun-v2/${pair}/assets`, { headers }, { ...env, DB: db });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ venue: "nadfun-v2", id: pair, walletAddress: wallet,
      delegate: SIMPLE_7702_ACCOUNT, monBalance: (20n * 10n ** 18n).toString(),
      token1: { address: meme, balance: "5" }, approvals: [] });
  });

  it("lists the v3 position manager allowance for each token", async () => {
    const { authStore, headers } = await session();
    const { db } = database({ first: () => ({ id: "wallet-1", address: wallet }) });
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => chain() })
      .request(`/v1/wallets/pairs/uniswap-v3/${pool}/assets`, { headers }, { ...env, DB: db });
    expect(response.status).toBe(200);
    const body = await response.json() as { delegate: unknown; approvals: unknown[] };
    expect(body.delegate).toBeNull();
    expect(body.approvals).toEqual([
      { token: token0, stage: "erc20", spender: UNISWAP_V3_MONAD.nonfungiblePositionManager, allowance: "7" },
      { token: token1, stage: "erc20", spender: UNISWAP_V3_MONAD.nonfungiblePositionManager, allowance: "7" },
    ]);
  });

  it("lists both Permit2 layers for v4, but none for native MON", async () => {
    const { authStore, headers } = await session();
    const { db } = database({ first: (sql) => sql.includes("managed_wallets") ? { id: "wallet-1", address: wallet }
      : { currency0: zeroAddress, currency1: token1, fee: 3000, tick_spacing: 60, hooks: zeroAddress } });
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => chain() })
      .request(`/v1/wallets/pairs/uniswap-v4/${v4Id}/assets`, { headers }, { ...env, DB: db });
    expect(response.status).toBe(200);
    const body = await response.json() as { token0: unknown; approvals: Array<{ token: string; stage: string }> };
    expect(body.token0).toMatchObject({ address: zeroAddress, symbol: "MON", balance: (20n * 10n ** 18n).toString() });
    expect(body.approvals.map(({ token, stage }) => `${token}:${stage}`))
      .toEqual([`${token1}:erc20`, `${token1}:permit2`]);
  });
});

describe("every position in one list", () => {
  it("merges v3 and v4 NFTs and nad.fun LP the wallet still holds, with each venue's own detail", async () => {
    const { authStore, headers } = await session();
    const { db } = database({
      first: () => ({ id: "wallet-1", address: wallet }),
      rows: (sql) => sql.includes("monad_v4_mint_intents") ? [{ token_id: "9", transaction_hash: "0x09" }]
        : sql.includes("FROM mint_intents") ? [{ token_id: "7", transaction_hash: "0x07" }]
          : sql.includes("monad_nadfun_intents") ? [{ pair_address: pair }] : [],
    });
    const base = chain({ balances: { [pair]: 250_000n } });
    const positions = { ...base, readContract: async (call: { address: Address; functionName: string }) => {
      if (call.address === UNISWAP_V3_MONAD.nonfungiblePositionManager) {
        if (call.functionName === "ownerOf") return wallet;
        if (call.functionName === "positions") return [0n, zeroAddress, token0, token1, 500, -100, 100, 75n, 0n, 0n, 3n, 4n];
      }
      if (call.address === UNISWAP_V4_MONAD.positionManager) {
        if (call.functionName === "ownerOf") return wallet;
        if (call.functionName === "getPoolAndPositionInfo") {
          return [v4Key, (((1n << 24n) - 60n) << 8n) | (60n << 32n)];
        }
        if (call.functionName === "getPositionLiquidity") return 50n;
      }
      if (call.address === UNISWAP_V4_MONAD.stateView && call.functionName === "getPositionInfo") return [50n, 0n, 0n];
      if (call.address === UNISWAP_V4_MONAD.stateView && call.functionName === "getFeeGrowthInside") {
        return [2n * 2n ** 128n, 0n];
      }
      return base.readContract(call as never);
    },
    // A v3 collect simulated from the owner returns what it would collect now.
    call: async ({ to, account }: { to: Address; account: Address }) => {
      expect(to).toBe(UNISWAP_V3_MONAD.nonfungiblePositionManager);
      expect(account).toBe(wallet);
      return { data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [11n, 12n]) };
    } } as unknown as MonadV3PoolClient;
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => positions,
      monUsd: async () => 0.03 }).request("/v1/wallets/positions", { headers }, { ...env, DB: db });
    expect(response.status).toBe(200);
    const body = await response.json() as { positions: Array<Record<string, unknown>> };
    const held = (tickLower: number, tickUpper: number, liquidity: bigint) => {
      const amounts = amountsForLiquidity({ sqrtPriceX96: 2n ** 96n, tickLower, tickUpper, liquidity });
      return { amount0: amounts.amount0.toString(), amount1: amounts.amount1.toString() };
    };
    expect(body.positions).toEqual([
      // The rounded principal is zero; nonzero unpriced fees still have no dollar value.
      expect.objectContaining({ venue: "uniswap-v3", id: "7", liquidity: "75",
        range: { tickLower: -100, tickUpper: 100 }, inRange: true, amounts: held(-100, 100, 75n),
        fees: { amount0: "11", amount1: "12" }, valueUsd: 0, feesUsd: null,
        pool: expect.objectContaining({ id: pool }) }),
      // The principal rounds to zero; native MON fees can still be priced.
      expect.objectContaining({ venue: "uniswap-v4", id: "9", liquidity: "50", inRange: true,
        range: { tickLower: -60, tickUpper: 60 }, amounts: held(-60, 60, 50n),
        fees: { amount0: "100", amount1: "0" }, valueUsd: expect.any(Number), feesUsd: expect.closeTo(3e-18, 25),
        pool: expect.objectContaining({ id: v4Id }) }),
      // A quarter of each reserve. This tiny pool fails the own-pool pricing depth threshold.
      expect.objectContaining({ venue: "nadfun-v2", id: pair, liquidity: "250000", range: null, inRange: true,
        amounts: { amount0: "1000", amount1: "500000" }, fees: null, valueUsd: null, feesUsd: null }),
    ]);
  });
});
