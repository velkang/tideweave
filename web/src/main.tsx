import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClientProvider } from "@tanstack/react-query";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { environmentId, monadNetwork, queryClient, wagmiConfig } from "./config/dynamic";
import { App } from "./App";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Failed to find root element");
if (!environmentId) throw new Error("VITE_DYNAMIC_ENV_ID is required");

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("UI Error caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center p-6 text-center">
          <div className="max-w-md rounded-[28px] border border-danger-line bg-card p-8 shadow-2xl">
            <h2 className="mb-2 text-2xl font-semibold text-ink">Something went wrong</h2>
            <p className="mb-5 text-sm text-ink-muted">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="min-h-11 rounded-full bg-accent px-6 text-sm font-semibold text-on-accent hover:bg-accent-hover"
            >
              Reload Tideweave
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DynamicContextProvider settings={{ environmentId, walletConnectors: [EthereumWalletConnectors],
        overrides: { evmNetworks: [monadNetwork] } }}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <DynamicWagmiConnector><App /></DynamicWagmiConnector>
          </QueryClientProvider>
        </WagmiProvider>
      </DynamicContextProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
