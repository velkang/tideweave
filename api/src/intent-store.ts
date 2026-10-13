import type { Context } from "hono";
import type { Hex } from "viem";
import { hashOpaqueValue } from "./auth";
import type { AppEnvironment } from "./env";

/** A request the route refuses, with the error code and status the client sees. */
export class RouteRejection extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 422 | 503) {
    super(code);
  }
}

/** Runs a route, turning a RouteRejection into its JSON error. */
export async function respond(context: Context<AppEnvironment>, run: () => Promise<Response>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RouteRejection) return context.json({ error: error.code }, error.status);
    throw error;
  }
}

export type StoredIntent = { intentId: string; status: string; replayed: boolean };

/**
 * Stores a prepared intent and its detail row in one batch. The same idempotency key returns the
 * intent already stored for it, or refuses when it was used for a different payload. Table and
 * column names come from the calling route, never from the request.
 */
export async function storeIntent(db: D1Database, input: { walletId: string; kind: string; payloadHash: Hex;
  idempotencyKey: string; automationRunId?: string; now: number; expiresAt: number; table: string;
  row: Record<string, string | number | null> }): Promise<StoredIntent> {
  const keyHash = await hashOpaqueValue(input.automationRunId ? `${input.automationRunId}:${input.idempotencyKey}` : input.idempotencyKey);
  const existing = await db.prepare(
    "SELECT id, status, payload_hash FROM wallet_intents WHERE wallet_id = ?1 AND kind = ?2 AND idempotency_key_hash = ?3",
  ).bind(input.walletId, input.kind, keyHash).first<{ id: string; status: string; payload_hash: string }>();
  if (existing) {
    if (existing.payload_hash !== input.payloadHash) throw new RouteRejection("IDEMPOTENCY_KEY_REUSED", 409);
    return { intentId: existing.id, status: existing.status, replayed: true };
  }
  const intentId = `${input.kind}_${crypto.randomUUID()}`;
  const row: Record<string, string | number | null> = { ...input.row, intent_id: intentId, created_at: input.now };
  const columns = Object.keys(row);
  await db.batch([
    db.prepare(
      `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at, created_at, updated_at,
        idempotency_key_hash, automation_run_id) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6, ?7, ?8)`,
    ).bind(intentId, input.walletId, input.kind, input.payloadHash, input.expiresAt, input.now, keyHash, input.automationRunId ?? null),
    db.prepare(`INSERT INTO ${input.table} (${columns.join(", ")}) VALUES (${columns.map((_, index) =>
      `?${index + 1}`).join(", ")})`).bind(...columns.map((column) => row[column])),
  ]);
  return { intentId, status: "pending", replayed: false };
}
