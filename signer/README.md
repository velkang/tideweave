# Tideweave signer Worker

This private Worker provisions Dynamic server wallets and signs Monad (chain 143) transactions through an authenticated Node service. It executes Monad Uniswap v3 and v4 intents and owner-authorized withdrawals. It accepts only current Monad intent kinds; unsupported intents and chains are rejected.

Every execution re-runs D1-backed policy checks and a fresh simulation, reserves a nonce, signs through the Dynamic service, submits, and is later reconciled against the receipt. `EMERGENCY_STOP=true` stops everything except exits and withdrawals.

The Dynamic service (`dynamic-wallet/`) handles only wallet provisioning and signing of transactions this Worker has already validated. Requests use HMAC-SHA256, a five-minute timestamp window, and a persisted one-time nonce. Locally the service runs on `127.0.0.1` (see the root README's localhost runbook); in production it runs on Railway with a persistent volume.

The context summary records a native-MON v4 deposit/full-exit cycle on mainnet; its receipts have not been independently verified here. Other venue cycles remain outstanding. Keep wallet balances small until each venue's cycle has passed.
