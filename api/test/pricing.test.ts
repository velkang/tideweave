import { getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { MONAD_TOKENS, NADFUN_MONAD, UNISWAP_V3_MONAD, monadV4PoolId, type MonadV3PoolClient } from "@tideweave/chain";
import { bestRoute, indexedPriceCandidates, UsdPriceResolver, type PriceCandidate } from "../src/pricing";
import type { AnyPair, Venue } from "../src/pairs";
import { DatabaseSync } from "node:sqlite";

const token = getAddress("0x1111111111111111111111111111111111111111");
const other = getAddress("0x2222222222222222222222222222222222222222");
const meta = (address: Address, decimals: number) => ({ address, decimals, symbol: "TOKEN" });
function pool(id: number, t0: Address, d0: number, t1: Address, d1: number, ratio: number, liquidity = 10n ** 22n): AnyPair {
  return { venue: "uniswap-v3", id: getAddress(`0x${String(id).padStart(40, "0")}`),
    token0: meta(t0, d0), token1: meta(t1, d1), fee: 500, tickSpacing: 10, tick: 0,
    sqrtPriceX96: BigInt(Math.floor(Math.sqrt(ratio * 10 ** (d1 - d0)) * 2 ** 96)), liquidity } as AnyPair;
}

function resolver(pools: AnyPair[], monUsd: number | null = 0.03) {
  const read = vi.fn(async (candidate: PriceCandidate) => pools.find((pool) => pool.id === candidate.id)!);
  const candidates = vi.fn(async (address: Address, quotes: Address[]) => pools.filter((pool) =>
    (pool.token0.address === address && quotes.includes(pool.token1.address)) ||
    (pool.token1.address === address && quotes.includes(pool.token0.address)))
    .map((pool) => ({ venue: pool.venue, id: pool.id })));
  const pricing = new UsdPriceResolver({} as D1Database, {} as MonadV3PoolClient, 100n, monUsd, { candidates, read });
  return { pricing, read, candidates };
}

describe("display USD prices from indexed Monad pools", () => {
  it.each<Venue>(["uniswap-v3", "uniswap-v4", "nadfun-v2"])("reads canonical %s pools at the response's safe block", async (venue) => {
    const quote = venue === "nadfun-v2" ? MONAD_TOKENS.WMON : MONAD_TOKENS.USDC;
    const key = { currency0: token, currency1: quote, fee: 500, tickSpacing: 10, hooks: zeroAddress };
    const id = venue === "uniswap-v4" ? monadV4PoolId(key) : other;
    const readContract = vi.fn(async (call: { address: Address; functionName: string; blockNumber?: bigint }) => {
      expect(call.blockNumber).toBe(100n);
      switch (call.functionName) {
        case "factory": return venue === "nadfun-v2" ? NADFUN_MONAD.factory : UNISWAP_V3_MONAD.factory;
        case "getPool": case "getPair": return id;
        case "token0": return token;
        case "token1": return quote;
        case "fee": return 500;
        case "tickSpacing": return 10;
        case "slot0": case "getSlot0": return [BigInt(Math.floor(Math.sqrt(2e-12) * 2 ** 96)), 0, 0, 500];
        case "liquidity": case "getLiquidity": return 10n ** 22n;
        case "getReserves": return [10n ** 24n, 10n ** 25n, 0];
        case "totalSupply": return 10n ** 24n;
        case "isLocked": return false;
        case "isGraduated": return true;
        case "decimals": return call.address === MONAD_TOKENS.USDC ? 6 : 18;
        case "symbol": return "TOKEN";
        default: throw new Error(call.functionName);
      }
    });
    const client = { readContract, getCode: async (input: { blockNumber?: bigint }) => {
      expect(input.blockNumber).toBe(100n); return "0x6000";
    } } as unknown as MonadV3PoolClient;
    const pricing = new UsdPriceResolver({} as D1Database, client, 100n, 0.03, {
      candidates: async (address) => address === token ? [{ venue, id,
        currency0: token, currency1: quote, fee: 500, tick_spacing: 10, hooks: zeroAddress }] : [],
    });
    expect((await pricing.price(token))?.usd).toBeCloseTo(venue === "nadfun-v2" ? 0.3 : 2);
    expect(readContract).toHaveBeenCalled();
  });
  it("prices direct routes in both token orders with different decimals", async () => {
    const direct = resolver([pool(1, token, 18, MONAD_TOKENS.USDC, 6, 2)]);
    expect((await direct.pricing.price(token))?.usd).toBeCloseTo(2);
    const reverse = resolver([pool(2, MONAD_TOKENS.USDC, 6, token, 24, 0.5)]);
    expect((await reverse.pricing.price(token))?.usd).toBeCloseTo(2);
  });

  it("prices through WETH and WBTC without allowing a third pool", async () => {
    for (const [bridge, decimals] of [[MONAD_TOKENS.WETH, 18], [MONAD_TOKENS.WBTC, 8]] as const) {
      const { pricing } = resolver([pool(1, token, 18, bridge, decimals, 0.01),
        pool(2, bridge, decimals, MONAD_TOKENS.USDC, 6, 3000), pool(3, other, 18, token, 18, 2)]);
      expect((await pricing.price(token))?.usd).toBeCloseTo(30);
      expect(await pricing.price(other)).toBeNull();
    }
  });

  it("normalizes native MON and WMON, and preserves stable prices when MON is unavailable", async () => {
    const { pricing } = resolver([pool(1, token, 18, zeroAddress, 18, 10)]);
    expect((await pricing.price(token))?.usd).toBeCloseTo(0.3);
    expect((await pricing.price(zeroAddress))?.usd).toBe((await pricing.price(MONAD_TOKENS.WMON))?.usd);
    const unavailable = resolver([pool(1, token, 18, MONAD_TOKENS.WMON, 18, 10)], null).pricing;
    expect(await unavailable.price(token)).toBeNull();
    expect(await unavailable.price(zeroAddress)).toBeNull();
    expect((await unavailable.price(MONAD_TOKENS.USDC))?.usd).toBe(1);
  });

  it("selects the deepest route and uses deterministic ties", async () => {
    const { pricing } = resolver([pool(1, token, 18, MONAD_TOKENS.USDC, 6, 2, 10n ** 18n),
      pool(2, token, 18, MONAD_TOKENS.USDT0, 6, 3, 10n ** 22n)]);
    expect((await pricing.price(token))?.usd).toBeCloseTo(3);
    expect(bestRoute([{ usd: 1, depth: 10, pools: ["b", "c"] }, { usd: 2, depth: 10, pools: ["b"] },
      { usd: 3, depth: 10, pools: ["a"] }])?.usd).toBe(3);
  });

  it("uses the weakest depth of a two-pool route", async () => {
    const { pricing } = resolver([pool(1, token, 18, MONAD_TOKENS.WETH, 18, 1, 10n ** 24n),
      pool(2, MONAD_TOKENS.WETH, 18, MONAD_TOKENS.USDC, 6, 2000, 10n ** 15n),
      pool(3, token, 18, MONAD_TOKENS.USDC, 6, 4, 10n ** 19n)]);
    expect((await pricing.price(token))?.usd).toBeCloseTo(4);
  });

  it("rejects thin, empty, invalid, and unreadable pools without losing a usable route", async () => {
    const thin = pool(1, token, 18, MONAD_TOKENS.USDC, 6, 2, 1n);
    const empty = pool(2, token, 18, MONAD_TOKENS.USDC, 6, 2, 0n);
    const invalid = pool(3, token, 18, MONAD_TOKENS.USDC, 6, 0);
    expect(await resolver([thin, empty, invalid]).pricing.price(token)).toBeNull();
    const { pricing, read } = resolver([thin, pool(4, token, 18, MONAD_TOKENS.USDC, 6, 2)]);
    read.mockRejectedValueOnce(new Error("RPC unavailable"));
    expect((await pricing.price(token))?.usd).toBeCloseTo(2);
  });

  it("deduplicates price and pool reads within one request", async () => {
    const { pricing, read, candidates } = resolver([pool(1, token, 18, MONAD_TOKENS.WETH, 18, 0.01),
      pool(2, MONAD_TOKENS.WETH, 18, MONAD_TOKENS.USDC, 6, 3000)]);
    await Promise.all([pricing.price(token), pricing.price(token), pricing.price(MONAD_TOKENS.WETH)]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(candidates).toHaveBeenCalledTimes(2);
  });

  it("uses independent prices for principal and fees, with a depth-checked anchor fallback", async () => {
    const ownPool = pool(9, token, 18, MONAD_TOKENS.USDC, 6, 10);
    const { pricing } = resolver([pool(1, token, 18, MONAD_TOKENS.USDC, 6, 2)]);
    expect(await pricing.value(ownPool, { amount0: 10n ** 18n, amount1: 1_000_000n })).toBeCloseTo(3);
    expect(await pricing.value(ownPool, { amount0: 10n ** 17n, amount1: 100_000n })).toBeCloseTo(0.3);
    expect(await resolver([]).pricing.value(ownPool, { amount0: 10n ** 18n, amount1: 0n })).toBeCloseTo(10);
    expect(await resolver([]).pricing.value({ ...ownPool, liquidity: 1n },
      { amount0: 10n ** 18n, amount1: 0n })).toBeNull();
    expect(await pricing.value(ownPool, null)).toBeNull();
  });

  it("bounds indexed candidates per counterpart and filters hooks", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE monad_v3_pool_directory (pool_address TEXT, token0_address TEXT COLLATE NOCASE,
        token1_address TEXT COLLATE NOCASE, updated_at INTEGER);
        CREATE TABLE monad_v4_pool_directory (pool_id TEXT, currency0 TEXT COLLATE NOCASE, currency1 TEXT COLLATE NOCASE,
          fee INTEGER, tick_spacing INTEGER, hooks TEXT, updated_at INTEGER);
        CREATE TABLE monad_nadfun_pair_directory (pair_address TEXT, token0_address TEXT COLLATE NOCASE,
          token1_address TEXT COLLATE NOCASE, updated_at INTEGER);`);
      const insert = sqlite.prepare("INSERT INTO monad_v3_pool_directory VALUES (?, ?, ?, ?)");
      for (let i = 1; i <= 6; i++) insert.run(`pool-${i}`, i % 2 ? token.toLowerCase() : MONAD_TOKENS.USDC,
        i % 2 ? MONAD_TOKENS.USDC : token.toLowerCase(), i);
      sqlite.prepare("INSERT INTO monad_v3_pool_directory VALUES (?, ?, ?, ?)").run("other", token, other, 100);
      sqlite.prepare("INSERT INTO monad_v4_pool_directory VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("hooked", token, MONAD_TOKENS.USDC, 500, 10, other, 100);
      const db = { prepare(sql: string) { return { bind(...args: string[]) {
        return { async all() { return { results: sqlite.prepare(sql).all(...args) } } };
      } } } } as unknown as D1Database;
      const candidates = await indexedPriceCandidates(db, token, [MONAD_TOKENS.USDC]);
      expect(candidates.map((row) => row.id)).toEqual(["pool-6", "pool-5", "pool-4", "pool-3"]);
    } finally { sqlite.close(); }
  });
});
