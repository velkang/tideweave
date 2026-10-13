import type { Hono } from "hono";
import type { Address } from "viem";
import { readWalletBalances, type BalanceClient } from "../balances";
import { monadClient } from "../clients";
import { readMonUsd } from "@tideweave/chain";
import type { AppEnvironment, RouteDeps } from "../env";

/** The managed wallet: provisioning, status, balances and pause. */
export function registerWalletRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  const { now } = deps;
  app.post("/v1/wallets/provision", async (context) => {
    const user = context.get("user");
    const response = await context.env.SIGNER.fetch(
      new Request("http://tideweave-signer/internal/v1/wallets/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          walletId: `wallet_${user.id}`,
        }),
      }),
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
  app.get("/v1/wallets/me", async (context) => {
    const wallet = await context.env.DB.prepare(
      `SELECT id, address, state, created_at, updated_at
       FROM managed_wallets WHERE user_id = ?1`,
    )
      .bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string; created_at: number; updated_at: number }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);

    // Auto-reconcile any pending submitted attempt
    const pendingAttempt = await context.env.DB.prepare(
      "SELECT id FROM mainnet_transaction_attempts WHERE wallet_id = ?1 AND status = 'submitted' LIMIT 1",
    )
      .bind(wallet.id)
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
        console.warn("Wallet refresh auto-reconciliation error", err);
      }
    }

    return context.json({ wallet });
  });
  app.get("/v1/wallets/balances", async (context) => {
    const wallet = await context.env.DB.prepare(
      "SELECT id, address FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    ).bind(context.get("user").id).first<{ id: string; address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    const client = monadClient(deps, context.env) as BalanceClient & {
      getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null }>;
    };
    try {
      const block = await client.getBlock({ blockTag: "safe" });
      if (block.number === null) return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
      const monUsd = await (deps.monUsd ?? (() => readMonUsd(client, block.number!).catch(() => null)))();
      return context.json(await readWalletBalances({ db: context.env.DB, client, walletId: wallet.id,
        address: wallet.address, blockNumber: block.number, monUsd }));
    } catch (error) {
      console.error("Wallet balances failed", error);
      return context.json({ error: "BALANCES_UNAVAILABLE" }, 502);
    }
  });
  app.post("/v1/wallets/pause", async (context) => {
    const user = context.get("user");
    await context.env.DB.prepare(
      `UPDATE managed_wallets SET state = 'paused', updated_at = ?2
       WHERE user_id = ?1 AND state = 'active'`,
    )
      .bind(user.id, now())
      .run();
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state, updated_at FROM managed_wallets WHERE user_id = ?1",
    )
      .bind(user.id)
      .first<{ id: string; address: string; state: string; updated_at: number }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    return context.json({ wallet });
  });
}
