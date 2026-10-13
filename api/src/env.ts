import type { MonadV3PoolClient } from "@tideweave/chain";
import type { AuthStore, AuthUser } from "./auth";
import type { AgentRun } from "./automation";
import type { LimitRequest, RateBucket } from "./rate-limit";

export type Bindings = Partial<Record<RateBucket, RateLimit>> & {
  DB: D1Database;
  SIGNER: Fetcher;
  // The web app's URL; SIWE messages are bound to its host.
  AUTH_URI: string;
  AUTH_COOKIE_SECURE?: string;
  // Optional override; without it, Monad's default public RPC is used.
  MONAD_RPC_URL?: string;
  // The indexer's private discovery endpoint; a pasted token address is looked up through it.
  INDEXER?: Fetcher;
  // Shared with the automation Worker; its requests act for one wallet under a mandate.
  AGENT_SECRET?: string;
  // The automation Worker: starts and steps through re-centring runs.
  AUTOMATION?: Fetcher;
};

type Variables = {
  authStore: AuthStore;
  user: AuthUser;
  sessionTokenHash: string;
  // Set when the automation Worker makes the request (see automation.ts).
  agentRun: AgentRun | undefined;
};

export type AppEnvironment = { Bindings: Bindings; Variables: Variables };

/** Seams for tests: each factory replaces a live client or store. */
export type AppDependencies = {
  limitRequest?: LimitRequest;
  createAuthStore?: (env: Bindings) => AuthStore;
  createMonadClient?: (env: Bindings) => MonadV3PoolClient;
  /** The MON price in dollars; by default read from the chain and cached briefly. */
  monUsd?: () => Promise<number | null>;
  now?: () => number;
};

/** What every route module receives from createApp. */
export type RouteDeps = AppDependencies & { now: () => number };
