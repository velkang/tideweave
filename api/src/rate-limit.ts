import type { Context } from "hono";
import { isAddress } from "viem";
import type { AppEnvironment, Bindings } from "./env";

export const RATE_BUCKETS = ["PUBLIC_READS", "AUTHENTICATION", "DISCOVERY_REQUESTS", "WALLET_READS",
  "WALLET_MUTATIONS", "RECONCILIATION"] as const;
export type RateBucket = typeof RATE_BUCKETS[number];
export type LimitRequest = (env: Bindings, bucket: RateBucket, key: string) => Promise<boolean>;

export const nativeLimit: LimitRequest = async (env, bucket, key) => {
  const binding = env[bucket];
  if (!binding) throw new Error(`RATE_LIMIT_BINDING_MISSING:${bucket}`);
  return (await binding.limit({ key })).success;
};

function reject(context: Context<AppEnvironment>) {
  context.header("Retry-After", "60");
  return context.json({ error: "RATE_LIMITED" }, 429);
}

/** Public limits run before authentication or any pool/discovery work. */
export function publicLimits(limit: LimitRequest) {
  return async (context: Context<AppEnvironment>, next: () => Promise<void>) => {
    const path = new URL(context.req.url).pathname;
    // In production this is supplied by Cloudflare, not X-Forwarded-For. Local requests share a bucket.
    const key = context.req.header("CF-Connecting-IP") ?? "local";
    if (path.startsWith("/v1/auth/") && !await limit(context.env, "AUTHENTICATION", key)) return reject(context);
    if (path === "/v1/pairs" || path.startsWith("/v1/pairs/")) {
      if (!await limit(context.env, "PUBLIC_READS", key)) return reject(context);
      const offset = Number(context.req.query("offset") ?? "0");
      if (path === "/v1/pairs" && isAddress((context.req.query("q") ?? "").trim().slice(0, 80)) &&
          !(Number.isSafeInteger(offset) && offset > 0) &&
          !await limit(context.env, "DISCOVERY_REQUESTS", key)) return reject(context);
    }
    await next();
  };
}

/** Session validation supplies the user ID; polling has a separate bucket from mutations. */
export function walletLimits(limit: LimitRequest) {
  return async (context: Context<AppEnvironment>, next: () => Promise<void>) => {
    const bucket = context.req.method === "GET" ? "WALLET_READS"
      : /\/attempts\/[^/]+\/reconcile$/.test(new URL(context.req.url).pathname)
        ? "RECONCILIATION" : "WALLET_MUTATIONS";
    if (!await limit(context.env, bucket, context.get("user").id)) return reject(context);
    await next();
  };
}
