import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src";

it("returns only the authenticated wallet's latest attempt, or null", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`CREATE TABLE managed_wallets (id TEXT, user_id TEXT);
      CREATE TABLE wallet_intents (id TEXT, kind TEXT);
      CREATE TABLE mainnet_transaction_attempts (id TEXT, intent_id TEXT, wallet_id TEXT,
        transaction_hash TEXT, status TEXT, final_reason TEXT, submitted_at INTEGER);
      INSERT INTO managed_wallets VALUES ('wallet-owner', 'owner'), ('wallet-other', 'other');
      INSERT INTO wallet_intents VALUES ('old-intent', 'approval'), ('intent', 'swap'), ('other-intent', 'withdrawal');
      INSERT INTO mainnet_transaction_attempts VALUES
        ('old', 'old-intent', 'wallet-owner', '0xold', 'confirmed', 'CONFIRMED', 1),
        ('latest', 'intent', 'wallet-owner', '0x123', 'submitted', NULL, 2),
        ('other', 'other-intent', 'wallet-other', '0xprivate', 'submitted', NULL, 3);`);
    const owners = new Map([[await hashOpaqueValue("owner-session"), "owner"],
      [await hashOpaqueValue("empty-session"), "empty"]]);
    const auth = { findSessionUser: async (hash: string) => owners.has(hash)
      ? { id: owners.get(hash), ownerAddress: "0x1111111111111111111111111111111111111111" } : null } as unknown as AuthStore;
    const db = { prepare(sql: string) { return { bind(...args: string[]) {
      return { async first() { return sqlite.prepare(sql).get(...args) ?? null } };
    } } } } as unknown as D1Database;
    const app = createApp({ limitRequest: async () => true, createAuthStore: () => auth });
    const env = { DB: db } as Bindings;
    expect((await app.request("/v1/wallets/attempts/latest", {}, env)).status).toBe(401);
    const read = (session: string) => app.request("/v1/wallets/attempts/latest",
      { headers: { cookie: `tideweave_session=${session}` } }, env);
    expect(await (await read("owner-session")).json()).toEqual({ attempt: { attemptId: "latest", intentId: "intent",
      kind: "swap", transactionHash: "0x123", status: "submitted", failureReason: null } });
    expect(await (await read("empty-session")).json()).toEqual({ attempt: null });
  } finally { sqlite.close(); }
});
