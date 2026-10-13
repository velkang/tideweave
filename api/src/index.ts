import { Hono } from "hono";
import { AuthError } from "./auth";
import { monadClient } from "./clients";
import { automationBoundary } from "./automation-boundary";
import { registerAutomationRoutes } from "./automation";
import { D1AuthStore } from "./d1-auth-store";
import type { AppDependencies, AppEnvironment, RouteDeps } from "./env";
import { D1IndexerHealthStore, getIndexerHealth } from "./indexer-health";
import { registerAuthRoutes } from "./routes/auth";
import { registerExploreRoutes, registerExploreWalletRoutes } from "./routes/explore";
import { registerIntentRoutes } from "./routes/intents";
import { registerNadfunRoutes } from "./routes/nadfun";
import { registerSwapRoutes } from "./routes/swaps";
import { registerWrapRoutes } from "./routes/wrap";
import { registerV3Routes } from "./routes/v3";
import { registerV4Routes } from "./routes/v4";
import { registerWalletRoutes } from "./routes/wallet";
import { registerWithdrawalRoutes } from "./routes/withdrawals";
import { nativeLimit, publicLimits, walletLimits } from "./rate-limit";

export type { AppEnvironment, Bindings } from "./env";

export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<AppEnvironment>();
  const deps: RouteDeps = { ...dependencies, now: dependencies.now ?? Date.now };
  const limit = dependencies.limitRequest ?? nativeLimit;
  app.use("/v1/*", publicLimits(limit));

  app.use("/v1/*", async (context, next) => {
    context.set(
      "authStore",
      dependencies.createAuthStore?.(context.env) ??
        new D1AuthStore(context.env.DB),
    );
    await next();
  });

  app.onError((error, context) => {
    if (error instanceof AuthError) {
      return context.json({ error: error.code }, error.status as 400);
    }
    console.error(error);
    return context.json({ error: "INTERNAL_ERROR" }, 500);
  });

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.get("/health/indexer", async (context) => {
    const health = await getIndexerHealth(
      new D1IndexerHealthStore(context.env.DB),
      { now: deps.now },
    );
    return context.json(health.body, health.httpStatus);
  });

  registerExploreRoutes(app, deps);
  // Everything registered after this needs a session or an agent run.
  registerAuthRoutes(app, deps);
  app.use("/v1/wallets/*", walletLimits(limit));
  app.use('/v1/wallets/*', automationBoundary());
  app.use('/v1/automation/*', walletLimits(limit));
  registerAutomationRoutes(app, deps.now, (env) => monadClient(deps, env));
  registerWalletRoutes(app, deps);
  registerExploreWalletRoutes(app, deps);
  registerV3Routes(app, deps);
  registerV4Routes(app, deps);
  registerNadfunRoutes(app, deps);
  registerSwapRoutes(app, deps);
  registerWrapRoutes(app, deps);
  registerWithdrawalRoutes(app, deps);
  registerIntentRoutes(app);

  return app;
}

export default createApp();
