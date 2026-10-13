import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, buildWrap, wrapPayloadHash, type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const env = { AUTH_URI: "http://localhost:5173" } as Bindings;
const ONE = 10n ** 18n;

async function setup(options: { mon?: bigint; wmon?: bigint; delegated?: boolean; revert?: boolean } = {}) {
  const token = `wrap-session-${Math.random()}`;
  const hash = await hashOpaqueValue(token);
  const authStore = { findSessionUser: async (given: string) => given === hash
    ? { id: "user-1", ownerAddress: wallet } : null } as unknown as AuthStore;
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) { let values: unknown[] = []; return {
    bind(...args: unknown[]) { values = args; return this; },
    async first() { if (sql.includes("FROM automation_runs")) return null;
      return sql.includes("managed_wallets") ? { id: "wallet-1", address: wallet, state: "active" } : null; },
    get sql() { return sql; }, get values() { return values; },
  }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    writes.push(...statements.map(({ sql, values }) => ({ sql, values }))); return [];
  } } as unknown as D1Database;
  const calls: Array<{ to: Address; data: Hex; value?: bigint }> = [];
  const client = {
    getCode: async () => options.delegated ? `0xef0100${"4cd241e8d1510e30b2076397afc7508ae59c66c9"}` : undefined,
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getBalance: async () => options.mon ?? 20n * ONE,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n ** 9n }),
    estimateGas: async () => 50_000n,
    call: async (input: { to: Address; data: Hex; value?: bigint }) => {
      calls.push(input);
      if (options.revert) throw new Error("reverted");
      return { data: "0x" as Hex };
    },
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (address === MONAD_TOKENS.WMON && functionName === "balanceOf") return options.wmon ?? 3n * ONE;
      throw new Error(`Unexpected ${functionName}`);
    },
  } as unknown as MonadV3PoolClient;
  const app = createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => client,
    now: () => 1_000_000_000 });
  const post = (body: unknown) => app.request("/v1/wallets/wrap/prepare", { method: "POST",
    headers: { cookie: `tideweave_session=${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
  { ...env, DB: db });
  return { post, writes, calls };
}

const key = "wrap-key-0123456789";

describe("wrapping and unwrapping MON", () => {
  it("prepares a wrap that sends exactly the amount to WMON", async () => {
    const { post, writes, calls } = await setup();
    const response = await post({ action: "wrap", amount: ONE.toString(), idempotencyKey: key });
    expect(response.status).toBe(201);
    const wrap = buildWrap({ action: "wrap", amount: ONE });
    expect(await response.json()).toMatchObject({ status: "pending",
      transaction: { to: MONAD_TOKENS.WMON, data: wrap.data, value: ONE.toString() } });
    expect(calls[0]).toMatchObject({ to: MONAD_TOKENS.WMON, value: ONE });
    expect(writes[0].values).toContain("monad_wrap");
    expect(writes[0].values).toContain(wrapPayloadHash(wrap));
    expect(writes[1].sql).toContain("monad_wrap_intents");
  });

  it("prepares an unwrap of WMON the wallet holds", async () => {
    const { post, writes } = await setup();
    const response = await post({ action: "unwrap", amount: ONE.toString(), idempotencyKey: key });
    expect(response.status).toBe(201);
    expect(writes[0].values).toContain("monad_unwrap");
  });

  it("refuses more than the wallet can wrap or unwrap", async () => {
    expect((await (await setup({ mon: ONE })).post({ action: "wrap", amount: ONE.toString(), idempotencyKey: key })).status)
      .toBe(422);
    const { post } = await setup({ mon: 12n * ONE, delegated: true });
    expect(await (await post({ action: "wrap", amount: (3n * ONE).toString(), idempotencyKey: key })).json())
      .toEqual({ error: "INSUFFICIENT_MON_RESERVE" });
    expect(await (await (await setup({ wmon: ONE })).post({ action: "unwrap", amount: (2n * ONE).toString(),
      idempotencyKey: key })).json()).toEqual({ error: "INSUFFICIENT_TOKEN_BALANCE" });
  });

  it("refuses a malformed request or one that would fail", async () => {
    const { post } = await setup();
    for (const body of [{ action: "burn", amount: "1", idempotencyKey: key }, { action: "wrap", amount: "0", idempotencyKey: key },
      { action: "wrap", amount: "1.5", idempotencyKey: key }, { action: "wrap", amount: "1", idempotencyKey: "short" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await (await (await setup({ revert: true })).post({ action: "wrap", amount: "1", idempotencyKey: key })).json())
      .toEqual({ error: "WRAP_SIMULATION_FAILED" });
  });
});
