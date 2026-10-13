import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SIMPLE_7702_ACCOUNT, buildMonadWithdrawal, monadWithdrawalDomain, monadWithdrawalMessage,
  monadWithdrawalTypes, type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const wallet = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const recipient = "0x3333333333333333333333333333333333333333" as Address;
const nonce = `0x${"ab".repeat(32)}` as const;
const now = 1_000_000;

async function fixture(asset: Address, nativeBalance: bigint, walletCode?: `0x${string}`) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const sessionToken = "withdrawal-session";
  const sessionHash = await hashOpaqueValue(sessionToken);
  const authStore = { findSessionUser: async (hash: string) => hash === sessionHash
    ? { id: "user-1", ownerAddress: owner.address } : null } as unknown as AuthStore;
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) { let values: unknown[] = []; return {
    bind(...args: unknown[]) { values = args; return this; },
    async first() { return sql.includes("FROM managed_wallets")
      ? { id: "wallet-1", address: wallet, state: "active", owner_address: owner.address }
      : null; },
    get sql() { return sql; }, get values() { return values; },
  }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    writes.push(...statements.map((item) => ({ sql: item.sql, values: item.values })));
    return [];
  } } as unknown as D1Database;
  const chain = { getBlock: async () => ({ number: 100n }),
    getBalance: async () => nativeBalance,
    getCode: async ({ address }: { address: Address }) => address === wallet ? walletCode : "0x6000",
    readContract: async () => 1_000n, simulateContract: async () => ({ result: true }),
    estimateGas: async () => 30_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
  } as unknown as MonadV3PoolClient;
  const withdrawal = buildMonadWithdrawal({ wallet, asset, recipient, amount: 100n,
    nonce, expiresAt: 1_120n });
  const signature = await owner.signTypedData({ domain: monadWithdrawalDomain,
    types: monadWithdrawalTypes, primaryType: "MonadWithdrawal",
    message: monadWithdrawalMessage(withdrawal) });
  const request = (override: Record<string, unknown> = {}) =>
    createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => chain,
      now: () => now }).request("/v1/wallets/monad/withdrawals/prepare", {
      method: "POST", headers: { cookie: `tideweave_session=${sessionToken}`,
        "content-type": "application/json" },
      body: JSON.stringify({ asset, recipient, amount: "100", nonce,
        expiresAt: 1_120, signature, ...override }),
    }, { DB: db, AUTH_URI: "http://localhost:5173" } as Bindings);
  return { request, writes };
}

describe("Monad withdrawal preparation", () => {
  it("prepares an owner-signed ERC-20 withdrawal and stores its exact transaction", async () => {
    const { request, writes } = await fixture(token, 100_000n);
    const response = await request();
    expect(response.status).toBe(201);
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain("monad_withdrawal");
    expect(writes[1].values).toContain(token);
    expect(writes[1].values).toContain("0");
  });

  it("reserves gas for native MON and rejects a tampered owner signature", async () => {
    const { request, writes } = await fixture(zeroAddress, 100n);
    const insufficient = await request();
    expect(insufficient.status).toBe(422);
    expect(await insufficient.json()).toMatchObject({ error: "INSUFFICIENT_MON_FOR_GAS" });
    const invalid = await request({ recipient: token });
    expect(invalid.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("keeps Monad's 10 MON reserve while the wallet is delegated for nad.fun batches", async () => {
    const delegated = `0xef0100${SIMPLE_7702_ACCOUNT.slice(2)}` as const;
    const { request } = await fixture(zeroAddress, 10n * 10n ** 18n, delegated);
    const response = await request();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INSUFFICIENT_MON_RESERVE" });
    const { request: plain } = await fixture(zeroAddress, 10n * 10n ** 18n);
    expect((await plain()).status).toBe(201);
  });
});

