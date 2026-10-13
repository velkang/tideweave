import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import { SIMPLE_7702_ACCOUNT, buildMonadWithdrawal, monadWithdrawalPayloadHash,
  type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const wallet = "0x1111111111111111111111111111111111111111" as Address;
const owner = "0x4444444444444444444444444444444444444444" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const recipient = "0x3333333333333333333333333333333333333333" as Address;
const nonce = `0x${"ab".repeat(32)}` as const;
const now = 1_000_000;

type Existing = { id: string; status: string; payload_hash: string; wallet_id: string };

function fixture(asset: Address, nativeBalance: bigint, options: { walletCode?: `0x${string}`; existing?: Existing } = {}) {
  const sessionToken = "withdrawal-session";
  const authStore = { findSessionUser: async (hash: string) => hash === await hashOpaqueValue(sessionToken)
    ? { id: "user-1", ownerAddress: owner } : null } as unknown as AuthStore;
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) { let values: unknown[] = []; return {
    bind(...args: unknown[]) { values = args; return this; },
    async first() {
      if (sql.includes("FROM managed_wallets")) return { id: "wallet-1", address: wallet, state: "active" };
      if (sql.includes("FROM monad_withdrawal_intents")) return options.existing ?? null;
      return null;
    },
    get sql() { return sql; }, get values() { return values; },
  }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
    return [];
  } } as unknown as D1Database;
  const chain = { getBlock: async () => ({ number: 100n }),
    getBalance: async () => nativeBalance,
    getCode: async ({ address }: { address: Address }) => address === wallet ? options.walletCode : "0x6000",
    readContract: async () => 1_000n, simulateContract: async () => ({ result: true }),
    estimateGas: async () => 30_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
  } as unknown as MonadV3PoolClient;
  const request = (override: Record<string, unknown> = {}) =>
    createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => chain,
      now: () => now }).request("/v1/wallets/monad/withdrawals/prepare", {
      method: "POST", headers: { cookie: `tideweave_session=${sessionToken}`,
        "content-type": "application/json" },
      body: JSON.stringify({ asset, recipient, amount: "100", nonce, ...override }),
    }, { DB: db, AUTH_URI: "http://localhost:5173" } as Bindings);
  return { request, writes };
}

describe("Monad withdrawal preparation", () => {
  it("prepares a send to any address from the signed-in session, with no owner signature", async () => {
    const { request, writes } = await fixture(token, 100_000n);
    const response = await request();
    expect(response.status).toBe(201);
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain("monad_withdrawal");
    expect(writes[1].sql).not.toContain("owner_signature");
    expect(writes[1].values).toContain(token);
    expect(writes[1].values).toContain(recipient);
    // The server sets the expiry: four minutes from now.
    expect(writes[1].values).toContain(Math.floor(now / 1_000) + 240);
  });

  it("returns the existing intent when the same send is retried", async () => {
    const payloadHash = monadWithdrawalPayloadHash(buildMonadWithdrawal({ wallet, asset: token, recipient,
      amount: 100n, nonce, expiresAt: 1n }));
    const existing = { id: "monad_withdrawal_1", status: "pending", payload_hash: payloadHash, wallet_id: "wallet-1" };
    const { request, writes } = await fixture(token, 100_000n, { existing });
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ intentId: "monad_withdrawal_1", existing: true });
    expect(writes).toHaveLength(0);
    const changed = await request({ amount: "99" });
    expect(changed.status).toBe(409);
  });

  it("refuses a nonce already used by another wallet", async () => {
    const payloadHash = monadWithdrawalPayloadHash(buildMonadWithdrawal({ wallet, asset: token, recipient,
      amount: 100n, nonce, expiresAt: 1n }));
    const existing = { id: "monad_withdrawal_1", status: "pending", payload_hash: payloadHash, wallet_id: "wallet-2" };
    const { request } = await fixture(token, 100_000n, { existing });
    expect((await request()).status).toBe(409);
  });

  it("rejects bad input and keeps MON for gas", async () => {
    const { request, writes } = await fixture(zeroAddress, 100n);
    const insufficient = await request();
    expect(insufficient.status).toBe(422);
    expect(await insufficient.json()).toMatchObject({ error: "INSUFFICIENT_MON_FOR_GAS" });
    expect((await request({ recipient: wallet })).status).toBe(400);
    expect((await request({ recipient: "not-an-address" })).status).toBe(400);
    expect((await request({ amount: "0" })).status).toBe(400);
    expect((await request({ nonce: "0x12" })).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("keeps Monad's 10 MON reserve while the wallet is delegated for nad.fun batches", async () => {
    const delegated = `0xef0100${SIMPLE_7702_ACCOUNT.slice(2)}` as const;
    const { request } = await fixture(zeroAddress, 10n * 10n ** 18n, { walletCode: delegated });
    const response = await request();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INSUFFICIENT_MON_RESERVE" });
    const { request: plain } = await fixture(zeroAddress, 10n * 10n ** 18n);
    expect((await plain()).status).toBe(201);
  });
});
