import { encodeFunctionResult, getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { SIMPLE_7702_ACCOUNT, UNISWAP_V3_MONAD, UNISWAP_V4_MONAD, managerAbi, monadV4PoolId,
  type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const pool = getAddress("0x3333333333333333333333333333333333333333");
const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");
const env = { DB: {} as D1Database, AUTH_URI: "http://localhost:5173" } as Bindings;

const mockReadContract = async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (address === UNISWAP_V3_MONAD.factory) return pool;
    if (address === token0 || address === token1) {
      if (functionName === "decimals") return address === token0 ? 6 : 24;
      if (functionName === "symbol") return address === token0 ? "A" : "B";
    }
    if (functionName === "factory") return UNISWAP_V3_MONAD.factory;
    if (functionName === "token0") return token0;
    if (functionName === "token1") return token1;
    if (functionName === "fee") return 500;
    if (functionName === "tickSpacing") return 10;
    if (functionName === "slot0") return [2n ** 96n, 0, 0, 0, 0, 0, true];
    if (functionName === "liquidity") return 100n;
    throw new Error("Unexpected read");
};
const chain = {
  getCode: async () => "0x6000",
  readContract: mockReadContract,
} as unknown as MonadV3PoolClient;

describe("Monad pair lookup", () => {
  it("prepares a full position close from simulated two-token proceeds", async () => {
    const sessionToken = "test-session-token";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (value: string) => value === sessionHash
      ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("FROM managed_wallets")
        ? { id: "wallet-1", address: token0, state: "active" } : null; },
      get sql() { return sql; }, get values() { return values; },
    }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
      return [];
    } } as unknown as D1Database;
    const decreased = encodeFunctionResult({ abi: managerAbi,
      functionName: "decreaseLiquidity", result: [100n, 200n] });
    const collected = encodeFunctionResult({ abi: managerAbi,
      functionName: "collect", result: [100n, 200n] });
    const closeResult = encodeFunctionResult({ abi: managerAbi, functionName: "multicall",
      result: [decreased, collected, "0x"] });
    const actionChain = { ...chain, getBlock: async () => ({ number: 100n,
      hash: `0x${"ab".repeat(32)}` }), getBalance: async () => 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
      estimateGas: async () => 100_000n,
      call: async () => ({ data: closeResult }),
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === UNISWAP_V3_MONAD.nonfungiblePositionManager) {
          if (functionName === "ownerOf") return token0;
          if (functionName === "positions") return [0n, token0, token0, token1, 500,
            -100, 100, 75n, 0n, 0n, 3n, 4n];
        }
        return mockReadContract({ address, functionName });
      },
    } as unknown as MonadV3PoolClient;
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => actionChain, now: () => 1_000_000 })
      .request("/v1/wallets/v3/positions/actions/prepare", {
        method: "POST", headers: { cookie: `tideweave_session=${sessionToken}`,
          "content-type": "application/json" },
        body: JSON.stringify({ action: "withdraw", tokenId: "7", slippageBps: 100,
          deadline: "1600", idempotencyKey: "close-test-key-1234" }),
      }, { ...env, DB: db });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ transaction: { chainId: 143 },
      simulation: { output: { decreased0: "100", decreased1: "200" } } });
    expect(writes).toHaveLength(2);
    expect(writes[0].values).toContain("monad_v3_position_withdraw");
    expect(writes[1].values).toContain(JSON.stringify({ poolAddress: pool,
      expected0: "100", expected1: "200" }));
  });

  it("prepares a two-token mint from live consumption and both allowances", async () => {
    const sessionToken = "test-session-token";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (value: string) => value === sessionHash
      ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("FROM managed_wallets")
        ? { id: "wallet-1", address: token0, state: "active" } : null; },
      get sql() { return sql; }, get values() { return values; },
    }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
      return [];
    } } as unknown as D1Database;
    const mintChain = { ...chain, getBlock: async () => ({ number: 100n,
      hash: `0x${"ab".repeat(32)}` }), getBalance: async () => 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
      estimateGas: async () => 100_000n,
      simulateContract: async () => ({ result: [7n, 100n, 800n, 900n] }),
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) =>
        functionName === "balanceOf" || functionName === "allowance"
          ? 10_000n : mockReadContract({ address, functionName }),
    } as unknown as MonadV3PoolClient;
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => mintChain, now: () => 1_000_000 })
      .request("/v1/wallets/v3/positions/mint/prepare", {
        method: "POST", headers: { cookie: `tideweave_session=${sessionToken}`,
          "content-type": "application/json" },
        body: JSON.stringify({ poolAddress: pool, amount0Desired: "1000", amount1Desired: "2000",
          tickLower: -100, tickUpper: 100, slippageBps: 100, deadline: "1600",
          idempotencyKey: "mint-test-key-1234" }),
      }, { ...env, DB: db });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ transaction: { chainId: 143 },
      simulation: { amount0: "800", amount1: "900" } });
    expect(writes).toHaveLength(2);
    expect(writes[1].values).toContain("792");
    expect(writes[1].values).toContain("891");
  });

  it("prepares a simulated token1 approval with a MON gas reserve", async () => {
    const sessionToken = "test-session-token";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (value: string) => value === sessionHash
      ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
    const managed = getAddress("0x5555555555555555555555555555555555555555");
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("FROM managed_wallets")
        ? { id: "wallet-1", address: managed, state: "active" } : null; },
      get sql() { return sql; }, get values() { return values; },
    }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
      return [];
    } } as unknown as D1Database;
    const approvalChain = (walletCode?: `0x${string}`) => ({ ...chain, getBlock: async () => ({ number: 100n,
      hash: `0x${"ab".repeat(32)}` }), getBalance: async () => 10n ** 18n,
      getCode: async ({ address }: { address: Address }) => address === managed ? walletCode : "0x6000",
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
      estimateGas: async () => 50_000n,
      simulateContract: async () => ({ result: true }) }) as unknown as MonadV3PoolClient;
    const prepare = (walletCode?: `0x${string}`) => createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => approvalChain(walletCode) }).request("/v1/wallets/v3/approvals/prepare",
      { method: "POST", headers: { cookie: `tideweave_session=${sessionToken}`,
        "content-type": "application/json" },
      body: JSON.stringify({ poolAddress: pool, tokenAddress: token1, amount: "1000",
        idempotencyKey: "approval-test-key-123" }) }, { ...env, DB: db });
    const response = await prepare();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ transaction: { chainId: 143, to: token1 } });
    expect(writes).toHaveLength(2);
    expect(writes[1].values).toContain(24);
    // Once delegated for nad.fun, 1 MON no longer covers Monad's 10 MON reserve.
    const delegated = await prepare(`0xef0100${SIMPLE_7702_ACCOUNT.slice(2)}`);
    expect(delegated.status).toBe(422);
    expect(await delegated.json()).toEqual({ error: "INSUFFICIENT_MON_RESERVE" });
  });

  it("prepares a simulated Monad v4 Permit2 approval for a pool token", async () => {
    const sessionToken = "v4-approval-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (hash: string) => hash === sessionHash
      ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
    const key = { currency0: token0, currency1: token1, fee: 500,
      tickSpacing: 10, hooks: getAddress("0x0000000000000000000000000000000000000000") };
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("managed_wallets")
        ? { id: "wallet-1", address: token0, state: "active" }
        : sql.includes("monad_v4_pool_directory")
          ? { currency0: token0, currency1: token1, fee: 500,
            tick_spacing: 10, hooks: key.hooks } : null; },
      get sql() { return sql; }, get values() { return values; },
    }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
      return [];
    } } as unknown as D1Database;
    const v4Chain = { getCode: async () => "0x6000",
      getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
      getBalance: async () => 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
      estimateGas: async () => 50_000n,
      call: async () => ({ data: "0x" }),
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === UNISWAP_V4_MONAD.stateView) {
          if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 500];
          if (functionName === "getLiquidity") return 1_000_000_000_000n;
        }
        if (address === UNISWAP_V4_MONAD.permit2 && functionName === "allowance") {
          return [0n, 0, 0];
        }
        if (address === token0 || address === token1) {
          if (functionName === "decimals") return address === token0 ? 6 : 24;
          if (functionName === "symbol") return address === token0 ? "A" : "B";
          if (functionName === "balanceOf") return 1_000_000n;
          if (functionName === "allowance") return 1_000_000n;
        }
        throw new Error("Unexpected read");
      } } as unknown as MonadV3PoolClient;
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => v4Chain, now: () => 1_000_000 })
      .request("/v1/wallets/v4/approvals/prepare", { method: "POST",
        headers: { cookie: `tideweave_session=${sessionToken}`,
          "content-type": "application/json" },
        body: JSON.stringify({ poolId: monadV4PoolId(key), tokenAddress: token1,
          stage: "permit2", amount: "1000", expiration: "2000",
          idempotencyKey: "v4-approval-key-1234" }),
      }, { ...env, DB: db });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ transaction: {
      chainId: 143, to: UNISWAP_V4_MONAD.permit2 },
      simulation: { gasEstimate: "50000" } });
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain("monad_v4_approval");
    expect(writes[1].values).toContain("permit2");
  });

  it("prepares a bounded two-token Monad v4 mint after both approval layers", async () => {
    const sessionToken = "v4-mint-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (hash: string) => hash === sessionHash
      ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
    const key = { currency0: token0, currency1: token1, fee: 500,
      tickSpacing: 10, hooks: getAddress("0x0000000000000000000000000000000000000000") };
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("managed_wallets")
        ? { id: "wallet-1", address: token0, state: "active" }
        : sql.includes("monad_v4_pool_directory")
          ? { currency0: token0, currency1: token1, fee: 500,
            tick_spacing: 10, hooks: key.hooks } : null; },
      get sql() { return sql; }, get values() { return values; },
    }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
      return [];
    } } as unknown as D1Database;
    const v4Chain = { getCode: async () => "0x6000",
      getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
      getBalance: async () => 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
      estimateGas: async () => 100_000n,
      call: async () => ({ data: "0x" }),
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === UNISWAP_V4_MONAD.stateView) {
          if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 500];
          if (functionName === "getLiquidity") return 1_000_000_000_000n;
        }
        if (address === UNISWAP_V4_MONAD.permit2 && functionName === "allowance") {
          return [10n ** 25n, 2000, 0];
        }
        if (address === token0 || address === token1) {
          if (functionName === "decimals") return address === token0 ? 6 : 24;
          if (functionName === "symbol") return address === token0 ? "A" : "B";
          if (functionName === "balanceOf" || functionName === "allowance") return 10n ** 25n;
        }
        throw new Error("Unexpected read");
      } } as unknown as MonadV3PoolClient;
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => v4Chain, now: () => 1_000_000 })
      .request("/v1/wallets/v4/positions/mint/prepare", { method: "POST",
        headers: { cookie: `tideweave_session=${sessionToken}`,
          "content-type": "application/json" },
        body: JSON.stringify({ poolId: monadV4PoolId(key),
          amount0Desired: "1000000000", amount1Desired: "1000000000000000000000",
          tickLower: -100, tickUpper: 100, slippageBps: 100,
          deadline: "1600", idempotencyKey: "v4-mint-key-123456" }),
      }, { ...env, DB: db });
    expect(response.status).toBe(201);
    const result = await response.json() as { simulation: { amount0: string; amount1: string;
      amount0Max: string; amount1Max: string } };
    expect(BigInt(result.simulation.amount0)).toBeGreaterThan(0n);
    expect(BigInt(result.simulation.amount1)).toBeGreaterThan(0n);
    expect(BigInt(result.simulation.amount0Max)).toBeLessThanOrEqual(1_000_000_000n);
    expect(BigInt(result.simulation.amount1Max)).toBeLessThanOrEqual(1_000_000_000_000_000_000_000n);
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain("monad_v4_mint");
    expect(writes[1].values).toContain(monadV4PoolId(key));
  });

  it("prepares a native-MON v4 mint that sends the MON side as value, with no approvals", async () => {
    const sessionToken = "v4-native-mint-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (hash: string) => hash === sessionHash
      ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
    const zero = getAddress("0x0000000000000000000000000000000000000000");
    const key = { currency0: zero, currency1: token1, fee: 500, tickSpacing: 10, hooks: zero };
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("managed_wallets")
        ? { id: "wallet-1", address: token0, state: "active" }
        : sql.includes("monad_v4_pool_directory")
          ? { currency0: zero, currency1: token1, fee: 500, tick_spacing: 10, hooks: zero } : null; },
      get sql() { return sql; }, get values() { return values; },
    }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
      return [];
    } } as unknown as D1Database;
    const simulatedValues: bigint[] = [];
    const v4Chain = { getCode: async () => "0x6000",
      getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
      getBalance: async () => 10n ** 20n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
      estimateGas: async ({ value }: { value: bigint }) => { simulatedValues.push(value); return 100_000n; },
      call: async ({ value }: { value: bigint }) => { simulatedValues.push(value); return { data: "0x" }; },
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === UNISWAP_V4_MONAD.stateView) {
          if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 500];
          if (functionName === "getLiquidity") return 1_000_000_000_000n;
        }
        if (address === UNISWAP_V4_MONAD.permit2 && functionName === "allowance") return [10n ** 25n, 2000, 0];
        if (address === token1) {
          if (functionName === "decimals") return 24;
          if (functionName === "symbol") return "B";
          if (functionName === "balanceOf" || functionName === "allowance") return 10n ** 25n;
        }
        throw new Error(`Unexpected read ${functionName} on ${address}`);
      } } as unknown as MonadV3PoolClient;
    const response = await createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => v4Chain, now: () => 1_000_000 })
      .request("/v1/wallets/v4/positions/mint/prepare", { method: "POST",
        headers: { cookie: `tideweave_session=${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ poolId: monadV4PoolId(key), amount0Desired: "1000000000000000000",
          amount1Desired: "1000000000000000000000000", tickLower: -100, tickUpper: 100, slippageBps: 100,
          deadline: "1600", idempotencyKey: "v4-native-mint-key-1" }),
      }, { ...env, DB: db });
    expect(response.status).toBe(201);
    const result = await response.json() as { transaction: { value: string };
      simulation: { amount0Max: string } };
    expect(result.transaction.value).toBe(result.simulation.amount0Max);
    expect(BigInt(result.transaction.value)).toBeGreaterThan(0n);
    expect(simulatedValues).toEqual([BigInt(result.transaction.value), BigInt(result.transaction.value)]);
    expect(writes[1].sql).toContain("value");
    expect(writes[1].values).toContain(result.transaction.value);
  });

  it("lists and prepares an exit for an owned Monad v4 NFT", async () => {
    const sessionToken = "v4-position-session";
    const sessionHash = await hashOpaqueValue(sessionToken);
    const authStore = { findSessionUser: async (hash: string) => hash === sessionHash
      ? { id: "user-1", ownerAddress: token0 } : null } as unknown as AuthStore;
    const key = { currency0: token0, currency1: token1, fee: 500,
      tickSpacing: 10, hooks: getAddress("0x0000000000000000000000000000000000000000") };
    const info = (((1n << 24n) - 100n) << 8n) | (100n << 32n);
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("managed_wallets")
        ? { id: "wallet-1", address: token0, state: "active" } : null; },
      async all() { return { results: [{ token_id: "7", transaction_hash: `0x${"ab".repeat(32)}` }] }; },
      get sql() { return sql; }, get values() { return values; },
    }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
      return [];
    } } as unknown as D1Database;
    const v4Chain = { getCode: async () => "0x6000",
      getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
      getBalance: async () => 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
      estimateGas: async () => 100_000n,
      call: async () => ({ data: "0x" }),
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === UNISWAP_V4_MONAD.positionManager) {
          if (functionName === "ownerOf") return token0;
          if (functionName === "getPoolAndPositionInfo") return [key, info];
          if (functionName === "getPositionLiquidity") return 1000n;
        }
        if (address === UNISWAP_V4_MONAD.stateView) {
          if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 500];
          if (functionName === "getLiquidity") return 1_000_000_000_000n;
        }
        if (address === token0 || address === token1) {
          if (functionName === "decimals") return address === token0 ? 6 : 24;
          if (functionName === "symbol") return address === token0 ? "A" : "B";
        }
        throw new Error("Unexpected read");
      } } as unknown as MonadV3PoolClient;
    const app = createApp({ limitRequest: async () => true, createAuthStore: () => authStore,
      createMonadClient: () => v4Chain, now: () => 1_000_000 });
    const listed = await app.request("/v1/wallets/positions", {
      headers: { cookie: `tideweave_session=${sessionToken}` },
    }, { ...env, DB: db });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ positions: [{ venue: "uniswap-v4", id: "7",
      range: { tickLower: -100, tickUpper: 100 }, liquidity: "1000",
      pool: { id: monadV4PoolId(key) } }] });
    const prepared = await app.request("/v1/wallets/v4/monad/positions/actions/prepare", {
      method: "POST", headers: { cookie: `tideweave_session=${sessionToken}`,
        "content-type": "application/json" },
      body: JSON.stringify({ action: "withdraw", tokenId: "7", slippageBps: 100,
        deadline: "1600", idempotencyKey: "v4-exit-key-123456" }),
    }, { ...env, DB: db });
    expect(prepared.status).toBe(201);
    expect(await prepared.json()).toMatchObject({ transaction: { chainId: 143,
      to: UNISWAP_V4_MONAD.positionManager }, simulation: { gasEstimate: "100000" } });
    expect(writes).toHaveLength(2);
    expect(writes[0].values).toContain("monad_v4_position_withdraw");
    expect(writes[1].values).toContain(monadV4PoolId(key));
    expect(writes[1].sql).toContain("remove_bps");
    expect(writes[1].values).toContain(10_000);

    // A partial removal records its share; a share outside 1–9,999 bps is refused.
    const partial = (removeBps: unknown, idempotencyKey: string) => app.request(
      "/v1/wallets/v4/monad/positions/actions/prepare", { method: "POST",
        headers: { cookie: `tideweave_session=${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "decrease", removeBps, tokenId: "7", slippageBps: 100, deadline: "1600",
          idempotencyKey }) }, { ...env, DB: db });
    expect((await partial(2_500, "v4-decrease-key-123456")).status).toBe(201);
    expect(writes[2].values).toContain("monad_v4_position_decrease");
    expect(writes[3].values).toContain("decrease");
    expect(writes[3].values).toContain(2_500);
    for (const invalid of [0, 10_000, 12.5, "50", undefined]) {
      expect((await partial(invalid, "v4-decrease-key-bad-1")).status).toBe(400);
    }
  });
});
