import { monad } from "@tideweave/chain";
import { createPublicClient, http } from "viem";
import type { DirectoryClient, ProtocolDirectory } from "./pool-discovery";
import { monadV3Directory } from "./monad-v3-directory";
import { monadV4Directory } from "./monad-v4-directory";
import { monadNadfunDirectory } from "./monad-nadfun-directory";

export type IndexerEnv = {
  DB: D1Database;
  DISCOVERY: DurableObjectNamespace;
  MONAD_RPC_URL?: string;
};

export const DIRECTORIES = [monadV3Directory, monadV4Directory, monadNadfunDirectory] as Array<
  ProtocolDirectory & { name: MonadDirectoryName }>;

export type MonadDirectoryName = "monad-v3" | "monad-v4" | "monad-nadfun";

export function createDirectoryClient(url?: string): DirectoryClient {
  return createPublicClient({ chain: monad, transport: http(url), batch: { multicall: true } }) as
    unknown as DirectoryClient;
}
