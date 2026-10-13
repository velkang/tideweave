import { describe, expect, it, vi } from "vitest";
import { createApp, type Bindings } from "../src";
import type { AuthStore } from "../src/auth";
import { nativeLimit, type RateBucket } from "../src/rate-limit";

const cases: Array<[string, string, RateBucket, string]> = [
  ["GET", "/v1/pairs", "PUBLIC_READS", "203.0.113.1"],
  ["POST", "/v1/auth/challenge", "AUTHENTICATION", "203.0.113.1"],
  ["GET", "/v1/pairs?q=0x1111111111111111111111111111111111111111", "DISCOVERY_REQUESTS", "203.0.113.1"],
  ["GET", "/v1/wallets/balances", "WALLET_READS", "user"],
  ["POST", "/v1/wallets/provision", "WALLET_MUTATIONS", "user"],
  ["POST", "/v1/wallets/intents/i/execute", "WALLET_MUTATIONS", "user"],
  ["POST", "/v1/wallets/attempts/a/reconcile", "RECONCILIATION", "user"],
];

describe("API abuse controls", () => {
  it.each(cases)("limits %s %s before route work", async (method, path, denied, key) => {
    const limit = vi.fn(async (_env: Bindings, bucket: RateBucket) => bucket !== denied);
    const auth = { findSessionUser: async () => ({ id: "user" }) } as unknown as AuthStore;
    const db = { prepare: vi.fn(() => { throw new Error("Route must not read D1") }) } as unknown as D1Database;
    const app = createApp({ limitRequest: limit, createAuthStore: () => auth });
    const response = await app.request(path, { method, headers: { "CF-Connecting-IP": "203.0.113.1",
      "X-Forwarded-For": "spoofed", cookie: "tideweave_session=test" } }, { DB: db } as Bindings);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({ error: "RATE_LIMITED" });
    expect(limit).toHaveBeenCalledWith(expect.anything(), denied, key);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("uses the configured native binding and fails closed if it is absent", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    expect(await nativeLimit({ PUBLIC_READS: { limit } } as unknown as Bindings, "PUBLIC_READS", "ip")).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: "ip" });
    await expect(nativeLimit({} as Bindings, "PUBLIC_READS", "ip")).rejects.toThrow("RATE_LIMIT_BINDING_MISSING");
  });
});
