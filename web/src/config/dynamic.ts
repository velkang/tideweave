import { QueryClient } from "@tanstack/react-query";
import { http } from "viem";
import { monad } from "viem/chains";
import { createConfig } from "wagmi";

export const environmentId = import.meta.env.VITE_DYNAMIC_ENV_ID;
export const queryClient = new QueryClient();

export const wagmiConfig = createConfig({
  chains: [monad],
  multiInjectedProviderDiscovery: false,
  transports: { [monad.id]: http(import.meta.env.VITE_MONAD_RPC_URL) },
});

export const monadNetwork = {
  chainId: monad.id,
  networkId: monad.id,
  name: monad.name,
  nativeCurrency: monad.nativeCurrency,
  rpcUrls: [import.meta.env.VITE_MONAD_RPC_URL || monad.rpcUrls.default.http[0]],
  blockExplorerUrls: [monad.blockExplorers.default.url],
  iconUrls: [],
};
