import { concat, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, NADFUN_MONAD, SIMPLE_7702_ACCOUNT, decodeNadBatch, type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const pair = getAddress("0x4444444444444444444444444444444444444444");
const meme = getAddress("0x7777777777777777777777777777777777777777");
const MON = 10n ** 18n;
const env = { AUTH_URI: "http://localhost:5173" } as Bindings;

async function setup(options: { mon?: bigint; delegate?: Address | null; lp?: bigint; state?: string } = {}) {
  const token = `nadfun-session-${Math.random()}`;
  const hash = await hashOpaqueValue(token);
  const authStore = { findSessionUser: async (given: string) => given === hash
    ? { id: "user-1", ownerAddress: wallet } : null } as unknown as AuthStore;
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) { let values: unknown[] = []; return {
    bind(...args: unknown[]) { values = args; return this; },
    async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("managed_wallets") ? { id: "wallet-1", address: wallet,
      state: options.state ?? "active" } : null; },
    get sql() { return sql; }, get values() { return values; },
  }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    writes.push(...statements.map(({ sql, values }) => ({ sql, values }))); return [];
  } } as unknown as D1Database;
  const calls: Array<{ stateOverride?: unknown }> = [];
  const delegate = options.delegate ?? null;
  const client = {
    getCode: async ({ address }: { address: Address }) => address === wallet
      ? (delegate ? concat(["0xef0100", delegate]) : undefined) : "0x6000",
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getBalance: async () => options.mon ?? 50n * MON,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n ** 9n }),
    call: async (input: { stateOverride?: unknown }) => { calls.push(input); return { data: "0x" }; },
    estimateGas: async () => 200_000n,
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (address === NADFUN_MONAD.factory) return pair;
      if (address === NADFUN_MONAD.router) return true;
      if (functionName === "balanceOf") return address === pair ? options.lp ?? 2_500n * MON : 1_000_000n * MON;
      if (address === pair) {
        return ({ factory: NADFUN_MONAD.factory, token0: MONAD_TOKENS.WMON, token1: meme,
          getReserves: [4_000n * MON, 2_000_000n * MON, 1], totalSupply: 1_000_000n * MON, isLocked: false } as
          Record<string, unknown>)[functionName];
      }
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return address === meme ? "MEME" : "WMON";
      throw new Error(`Unexpected ${functionName}`);
    },
  } as unknown as MonadV3PoolClient;
  const app = createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => client, now: () => 1_000_000 });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST",
    headers: { cookie: `tideweave_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body) }, { ...env, DB: db });
  return { post, writes, calls };
}

const deposit = { amount0Desired: (10n * MON).toString(), amount1Desired: (99_999n * MON).toString(),
  slippageBps: 100, idempotencyKey: "nadfun-deposit-key-1" };

describe("nad.fun deposits", () => {
  it("prepares a delegating batch, simulated as delegated, and stores its preview", async () => {
    const { post, writes, calls } = await setup();
    const response = await post(`/v1/wallets/nadfun/${pair}/deposit/prepare`, deposit);
    expect(response.status).toBe(201);
    const body = await response.json() as { transaction: { to: string; value: string; data: Hex; delegation: string };
      simulation: Record<string, string>; monReserve: string };
    expect(body.transaction).toMatchObject({ to: wallet, value: "0", delegation: SIMPLE_7702_ACCOUNT });
    expect(body.simulation).toMatchObject({ amount0: (10n * MON).toString(), amount1: (5_000n * MON).toString(),
      minLiquidity: (2_475n * MON).toString(), gasEstimate: "225000" });
    expect(body.monReserve).toBe((10n * MON).toString());
    expect(decodeNadBatch(body.transaction.data)).toHaveLength(4);
    expect(calls[0].stateOverride).toEqual([{ address: wallet, code: concat(["0xef0100", SIMPLE_7702_ACCOUNT]) }]);
    expect(writes[0].values).toContain("monad_nadfun_add");
    expect(writes[1].sql).toContain("monad_nadfun_intents");
    expect(writes[1].values).toContain("add");
  });

  it("needs no authorization once the wallet is delegated", async () => {
    const { post, calls } = await setup({ delegate: SIMPLE_7702_ACCOUNT });
    const body = await (await post(`/v1/wallets/nadfun/${pair}/deposit/prepare`, deposit)).json() as
      { transaction: { delegation: string | null }; simulation: { gasEstimate: string } };
    expect(body.transaction.delegation).toBeNull();
    expect(body.simulation.gasEstimate).toBe("200000");
    expect(calls[0].stateOverride).toBeUndefined();
  });

  it("keeps Monad's 10 MON reserve for a delegated wallet", async () => {
    const { post } = await setup({ mon: 10n * MON });
    const response = await post(`/v1/wallets/nadfun/${pair}/deposit/prepare`, deposit);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INSUFFICIENT_MON_RESERVE" });
  });

  it("refuses a wallet delegated to another contract, and a paused wallet", async () => {
    expect((await (await setup({ delegate: meme })).post(`/v1/wallets/nadfun/${pair}/deposit/prepare`, deposit))
      .status).toBe(409);
    expect((await (await setup({ state: "paused" })).post(`/v1/wallets/nadfun/${pair}/deposit/prepare`, deposit))
      .status).toBe(409);
  });

  it("rejects a deposit missing one side", async () => {
    const { post } = await setup();
    expect((await post(`/v1/wallets/nadfun/${pair}/deposit/prepare`, { ...deposit, amount1Desired: "0" })).status)
      .toBe(400);
  });
});

describe("nad.fun withdrawals and clearing the delegation", () => {
  it("withdraws all LP by default, even from a paused wallet", async () => {
    const { post, writes } = await setup({ delegate: SIMPLE_7702_ACCOUNT, state: "paused" });
    const response = await post(`/v1/wallets/nadfun/${pair}/withdraw/prepare`,
      { slippageBps: 100, idempotencyKey: "nadfun-withdraw-key-1" });
    expect(response.status).toBe(201);
    const body = await response.json() as { simulation: Record<string, string> };
    expect(body.simulation).toMatchObject({ liquidity: (2_500n * MON).toString(), amount0Min: (99n * MON / 10n).toString() });
    expect(writes[1].values).toContain("remove");
  });

  it("refuses to withdraw more LP than the wallet holds", async () => {
    const { post } = await setup({ delegate: SIMPLE_7702_ACCOUNT });
    const response = await post(`/v1/wallets/nadfun/${pair}/withdraw/prepare`,
      { liquidity: (2_501n * MON).toString(), slippageBps: 100, idempotencyKey: "nadfun-withdraw-key-2" });
    expect(await response.json()).toEqual({ error: "INSUFFICIENT_LP_BALANCE" });
  });

  it("clears a delegation, and refuses when there is none", async () => {
    const delegated = await setup({ delegate: SIMPLE_7702_ACCOUNT });
    const response = await delegated.post("/v1/wallets/delegation/clear/prepare", { idempotencyKey: "clear-key-000001" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ transaction: { to: wallet, data: "0x",
      delegation: "0x0000000000000000000000000000000000000000" } });
    const plain = await setup();
    expect(await (await plain.post("/v1/wallets/delegation/clear/prepare", { idempotencyKey: "clear-key-000002" }))
      .json()).toEqual({ error: "NOT_DELEGATED" });
  });
});
