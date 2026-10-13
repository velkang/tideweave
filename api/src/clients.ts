import { monad, type MonadV3PoolClient } from "@tideweave/chain";
import { createPublicClient, http } from "viem";
import type { Bindings, RouteDeps } from "./env";

/** The Monad client for a request: the test seam when given, else the configured RPC. */
export function monadClient(deps: RouteDeps, env: Bindings): MonadV3PoolClient {
  return deps.createMonadClient?.(env) ??
    // Reads issued together go out as one multicall, so a listed page costs about one request.
    createPublicClient({ chain: monad, transport: http(env.MONAD_RPC_URL), batch: { multicall: true } }) as
      unknown as MonadV3PoolClient;
}
