import type { Hono } from "hono";
import type { AppEnvironment } from "../env";
import { isIdentifier } from "../http";

/** Hands a prepared intent to the signer, and reconciles a submitted attempt. */
export function registerIntentRoutes(app: Hono<AppEnvironment>) {
  app.get("/v1/wallets/attempts/latest", async (context) => {
    const attempt = await context.env.DB.prepare(
      `SELECT a.id AS attemptId, a.intent_id AS intentId, wi.kind,
              a.transaction_hash AS transactionHash, a.status, a.final_reason AS failureReason
       FROM mainnet_transaction_attempts a
       JOIN managed_wallets mw ON mw.id = a.wallet_id
       JOIN wallet_intents wi ON wi.id = a.intent_id
       WHERE mw.user_id = ?1
       ORDER BY a.submitted_at DESC, a.id DESC LIMIT 1`,
    ).bind(context.get("user").id).first();
    return context.json({ attempt });
  });
  app.get('/v1/wallets/intents/:intentId/attempt', async (context) => {
    const intentId = context.req.param('intentId');
    if (!isIdentifier(intentId)) return context.json({ error: 'INVALID_REQUEST' }, 400);
    const owned = await context.env.DB.prepare(`SELECT wi.id, wi.status FROM wallet_intents wi
      JOIN managed_wallets mw ON mw.id = wi.wallet_id WHERE wi.id = ?1 AND mw.user_id = ?2
        AND (?3 IS NULL OR wi.automation_run_id = ?3)`)
      .bind(intentId, context.get('user').id, context.get('agentRun')?.id ?? null).first<{ id: string; status: string }>();
    if (!owned) return context.json({ error: 'INTENT_NOT_FOUND' }, 404);
    const attempt = await context.env.DB.prepare(`SELECT id AS attemptId, transaction_hash AS transactionHash,
      status, block_number AS blockNumber, final_reason AS failureReason FROM mainnet_transaction_attempts
      WHERE intent_id = ?1 ORDER BY submitted_at DESC, id DESC LIMIT 1`).bind(intentId).first();
    return context.json({ status: owned.status, attempt });
  });
  app.post("/v1/wallets/intents/:intentId/execute", async (context) => {
    const intentId = context.req.param("intentId");
    if (!isIdentifier(intentId)) {
      return context.json({ error: "INVALID_REQUEST" }, 400);
    }
    // The agent may only send what its own run prepared.
    const owned = await context.env.DB.prepare(
      `SELECT wi.id, mw.id AS wallet_id
       FROM wallet_intents wi
       JOIN managed_wallets mw ON mw.id = wi.wallet_id
       WHERE wi.id = ?1 AND mw.user_id = ?2 AND (?3 IS NULL OR wi.automation_run_id = ?3)`,
    ).bind(intentId, context.get("user").id, context.get("agentRun")?.id ?? null)
      .first<{ id: string; wallet_id: string }>();
    if (!owned) return context.json({ error: "INTENT_NOT_FOUND" }, 404);

    // If wallet has a submitted attempt, reconcile it first before failing with WALLET_EXECUTION_BUSY!
    const pendingAttempt = await context.env.DB.prepare(
      "SELECT id FROM mainnet_transaction_attempts WHERE wallet_id = ?1 AND status = 'submitted' LIMIT 1",
    )
      .bind(owned.wallet_id)
      .first<{ id: string }>();

    if (pendingAttempt) {
      try {
        await context.env.SIGNER.fetch(
          new Request("http://tideweave-signer/internal/v1/attempts/reconcile-mainnet", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ attemptId: pendingAttempt.id }),
          }),
        );
      } catch (err) {
        console.warn("Pre-execution reconciliation error", err);
      }
    }

    const response = await context.env.SIGNER.fetch(
      new Request("http://tideweave-signer/internal/v1/intents/execute-mainnet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intentId }),
      }),
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
  app.post("/v1/wallets/attempts/:attemptId/reconcile", async (context) => {
    const attemptId = context.req.param("attemptId");
    if (!isIdentifier(attemptId)) {
      return context.json({ error: "INVALID_REQUEST" }, 400);
    }
    const owned = await context.env.DB.prepare(
      `SELECT mta.id
       FROM mainnet_transaction_attempts mta
       JOIN managed_wallets mw ON mw.id = mta.wallet_id
       JOIN wallet_intents wi ON wi.id = mta.intent_id
       WHERE mta.id = ?1 AND mw.user_id = ?2 AND (?3 IS NULL OR wi.automation_run_id = ?3)`,
    ).bind(attemptId, context.get("user").id, context.get("agentRun")?.id ?? null).first<{ id: string }>();
    if (!owned) return context.json({ error: "ATTEMPT_NOT_FOUND" }, 404);

    const response = await context.env.SIGNER.fetch(
      new Request("http://tideweave-signer/internal/v1/attempts/reconcile-mainnet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId }),
      }),
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
}
