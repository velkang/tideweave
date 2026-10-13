# Tideweave

**Managed liquidity on Monad.** Swap any token, add liquidity to Uniswap v3, Uniswap v4 and nad.fun pools, and manage or exit positions from one app. You never have to understand ticks, approvals or routing.

Tideweave gives each user a managed wallet on Monad mainnet. Tideweave prepares every transaction, simulates it, and checks it again against live chain state before anything is signed.

Built for **Monad Metropolis**, track _Onchain Finance & Trading_.

---

## What it does

- **Explore every pool in one list.** Uniswap v3, Uniswap v4 (including native-MON pools) and graduated nad.fun pairs sit side by side. Search by symbol, or paste a token address to find its pools straight from the factories. Almost-empty pools are hidden.
- **Add liquidity in plain terms.**
  - Pick a range: _Wide_, _Balanced_, _Narrow_ or _Any price_, or set your own prices.
  - Type one amount and the other fills in, or use 25 / 50 / 75 / Max.
  - Missing a token? **Get it** with a swap, without leaving the page.
  - One **Confirm** runs every approval and the deposit in order, with a checklist.
- **Swap any token for any other.**
  - Tideweave finds routes through up to two pools, MON included. It wraps or unwraps MON where a pool holds WMON, quotes every route, and uses the one that pays the most.
  - Longer routes run step by step. Before each later step the rest of the route is quoted again; if it would now return less than you reviewed, it stops and tells you what you hold.
- **Positions.**
  - Each position shows whether it is earning, its range against today's price, what it holds, its uncollected fees (read live) and its dollar value.
  - You can collect fees, remove 25 / 50 / 75 / 100%, or add more.
- **Wallet.** See the address to fund and your balances, swap a held token, and send MON or any token to any address

## Why it is safe to hand it a wallet

Every action follows one pipeline:

1. **Prepare (API).** Read state at Monad's _safe_ block, build the exact calldata, simulate it, check that MON covers gas and any reserve, and store an idempotent _intent_.
2. **Re-check (signer).** Just before signing, rebuild the expected transaction from the stored intent and the live chain. Then apply the per-venue policy:
   - the target and calldata must match exactly;
   - native value is allowed only where it is expected;
   - deadlines are bounded;
   - swaps are re-quoted, and are refused if the pool no longer gives the stored minimum or would move more than 5%.
3. **Sign.** A separate Dynamic MPC service signs chain-143 transactions only. It is authenticated by HMAC with single-use nonces, never broadcasts, and the signer checks that the signature covers exactly what it built.
4. **Broadcast and reconcile.** The signer sends the transaction and follows it to a receipt.

## Built during Metropolis

Everything Monad-specific was built during the Metropolis window:

- the Monad pair model and the single Explore screen for Uniswap v3, v4 and nad.fun;
- native-MON v4 pools;
- nad.fun liquidity through EIP-7702 batches;
- routed swaps with wrap and unwrap;
- the positions page with live fees and partial removal;
- the wallet drawer;
- the Dynamic MPC custody service;
- the signer policies for every Monad venue.

The repository was published as a single commit. The dated mainnet transactions below show the product working during the window.

## On Monad mainnet

Real transactions from a Tideweave managed wallet (`0x90e242E0ABc00Eb8bceBe3Eb91a9B0AE7e7799ef`), each prepared, checked and signed through the pipeline above. All of them use the Uniswap v4 MON / MON.b.gMON pool (native MON, 0.048% fee).

| Date (UTC) | Action                                                                    | Transaction                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8 Oct      | Swap 10 MON for 9.0716 MON.b.gMON                                         | [0x9b9e…970c](https://monadscan.com/tx/0x9b9e252bd6353d0306f0f3a018597a42a3cfddecf102dc4cadf13770656c970c)                                                                                                              |
| 8 Oct      | Allow Permit2 to move MON.b.gMON                                          | [0xef83…9802](https://monadscan.com/tx/0xef839e7d4028c000a293a494d0cdef7e31b07a03ab012942b1a2fe2c41329802)                                                                                                              |
| 8 Oct      | Allow the v4 position manager through Permit2                             | [0x714e…3a09](https://monadscan.com/tx/0x714e1d89dc3950fb430e82418dcda77cc331343312e571acec760b056a993a09)                                                                                                              |
| 8 Oct      | Add 7.0977 MON + 6.7513 MON.b.gMON (position #636714)                     | [0x7691…e30e](https://monadscan.com/tx/0x769190d4373f57176924d0f83a1f90df7238ba9faa17a19f74a9c850fd5de30e)                                                                                                              |
| 8 Oct      | Close position #636714: 7.0977 MON + 6.7513 MON.b.gMON back to the wallet | [0x94a3…e6fb](https://monadscan.com/tx/0x94a3f69a62cd53be11f49f630657a30c7a880458a26d4437d42d8f00835ee6fb)                                                                                                              |
| 8 Oct      | Allow Permit2, then the Universal Router, to swap MON.b.gMON              | [0x2049…c6e4](https://monadscan.com/tx/0x2049dc2a6ad69663003d9ac6a5865df902755d0adbdc4411de13f0e18a42c6e4), [0x7b5b…1caf](https://monadscan.com/tx/0x7b5b2228103e11f52f53cc5a0c070c92b778bd6cfa9d4c7dd4a189cc3c721caf)  |
| 8 Oct      | Swap 9.0716 MON.b.gMON for 9.9908 MON                                     | [0x7d27…48d4](https://monadscan.com/tx/0x7d27ac80105fdb7c4457668e7410849a2243496f39f9d66b1638cae4e24648d4)                                                                                                              |
| 13 Oct     | Swap 24.9373 MON for 22.6200 MON.b.gMON                                   | [0x4302…e2b4](https://monadscan.com/tx/0x43027cde76f2e64754f08da2529ee9d4d7bf096cc89af9ceb5ada69a4c9de2b4)                                                                                                              |
| 13 Oct     | Allow Permit2, then the v4 position manager, to move MON.b.gMON           | [0x8273…6f5d](https://monadscan.com/tx/0x8273865af40439ed399194c562122f7be3c59b957f2084f442e2e481ba0b6f5d), [0xeb2e…c6456](https://monadscan.com/tx/0xeb2e91435ee8f74a8cf85f7e0f0ebeb8ce8a7835d208241e0e8c9afac95c6456) |
| 13 Oct     | Add 16.8218 MON + 15.8803 MON.b.gMON (position #637731)                   | [0x32c2…3570](https://monadscan.com/tx/0x32c25171f58e109dd0fdd6a12484dedd668c2a889a8ca9b5ae23fccb01103570)                                                                                                              |

The other flows run on an anvil fork of Monad mainnet against the real contracts: nad.fun deposit and exit as one EIP-7702 batch, swaps on every venue, partial removal of a v4 position, and a routed swap (wrap → v3 → v4 → unwrap). See [Tests](#tests).

## How it is built

| Package           | What it does                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/`            | React 19, Vite and Tailwind. Explore, pool page, Swap, Positions and the wallet drawer. Route finding (`lib/routing.ts`), step-by-step route execution (`lib/route-run.ts`) and deposit maths (`lib/deposit-math.ts`). |
| `api/`            | Cloudflare Worker (Hono) on D1. Owner sign-in, the pair list and factory discovery, live pair and position reads (holdings, fees, USD value), wallet balances, and the prepare routes for every action.                |
| `signer/`         | Private Worker. Loads each intent, re-reads the chain, applies policy, reserves a nonce, signs through the Dynamic service, broadcasts and reconciles.                                                                 |
| `chain/`          | Shared viem reads and transaction builders: Uniswap v3, Uniswap v4 (with native MON), nad.fun EIP-7702 batches, swaps, wrap and unwrap, exact position maths, and depth pricing.                                       |
| `indexer/`        | Worker and Durable Object that scan the v3, v4 and nad.fun factories into pool directories.                                                                                                                            |
| `automation/`     | Optional agent Worker. It looks after positions within limits the user sets, and every agent action goes through the same signer policy.                                                                               |
| `dynamic-wallet/` | Node service holding encrypted Dynamic MPC key shares. It signs only, never broadcasts, and only for Monad (chain 143).                                                                                                |

### Venues

- **Uniswap v3:** reads and mints through the NonfungiblePositionManager; swaps through SwapRouter02.
- **Uniswap v4:**
  - deposits and swaps go through Permit2, the PositionManager and UniversalRouter;
  - native MON is supported as `currency0`;
  - a partial removal returns its share of tokens and fees in one transaction and keeps the NFT.
- **nad.fun V2:** graduated pairs have no liquidity router, so a deposit or exit runs as one EIP-7702 batch from the managed wallet, delegated to eth-infinitism's Simple7702Account. The batch reverts as a whole if the minimum LP or token amounts aren't met. While delegated, Monad requires the wallet to keep 10 MON; removing the setup frees it.

## Run it locally (against Monad mainnet)

You need Node.js 22.13+ and pnpm 11. Everything runs on your machine against Monad mainnet (chain 143), so transactions are real. Fund the managed wallet with small amounts only.

1. **Install:** `pnpm install`
2. **Configure.** Copy each example file and fill it in. Secrets stay in these ignored files and are never committed.
   - `api/.dev.vars`: `AUTH_URI=http://localhost:5173`, `AUTH_COOKIE_SECURE=false`, `AGENT_SECRET`, `MONAD_RPC_URL`
   - `signer/.dev.vars`: `DYNAMIC_SIGNER_URL=http://127.0.0.1:3000`, `DYNAMIC_SIGNER_SHARED_SECRET`, `EMERGENCY_STOP=false`, `MONAD_RPC_URL`
   - `automation/.dev.vars`: `AGENT_SECRET` (the same as the api's), `MONAD_RPC_URL`, plus the model settings if you use automation
   - `dynamic-wallet/.env`: `DYNAMIC_ENV_ID`, `DYNAMIC_AUTH_TOKEN`, `DYNAMIC_SIGNER_SHARED_SECRET` (the same as the signer's), `DYNAMIC_WALLET_ENCRYPTION_KEY`, `DYNAMIC_WALLET_DATA_DIR=./.data`
   - `web/.env.local`: `VITE_DYNAMIC_ENV_ID`, `VITE_MONAD_RPC_URL`

   Generate each secret with `openssl rand -hex 32`. In the Dynamic dashboard, allow `http://localhost:5173` as an origin.

3. **Create the local database:** `pnpm db:migrate:local`
4. **Start each service in its own terminal**, the workers first:

   ```bash
   pnpm dev          # API, signer and automation workers on :8787
   pnpm indexer:dev  # pool indexer on :8788
   pnpm dynamic:dev  # Dynamic signing service on 127.0.0.1:3000
   pnpm web:dev      # web app on http://localhost:5173
   ```

5. Open `http://localhost:5173`, connect your wallet, create the managed wallet from the wallet button in the header, and send it a little MON.

Set `EMERGENCY_STOP=true` in `signer/.dev.vars` and restart the workers to stop everything except exits and withdrawals.

`dynamic-wallet/.data/` and `DYNAMIC_WALLET_ENCRYPTION_KEY` together control every wallet created locally. Back up both before funding anything.

## Tests

```bash
pnpm check   # type-check every package
pnpm test    # unit and route tests for every package
```

Fork tests run the real contracts on an anvil fork of Monad mainnet with a local test key:

```bash
anvil --fork-url https://rpc.monad.xyz --port 8599 --chain-id 143
FORK_MONAD_RPC=http://127.0.0.1:8599 pnpm --filter @tideweave/chain test fork-
```

They cover:

| File                                   | Flow                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| `chain/test/fork-nadfun.test.ts`       | nad.fun deposit, removal and clearing the delegation |
| `chain/test/fork-swaps.test.ts`        | swaps on v3, v4 (native MON both ways) and nad.fun   |
| `chain/test/fork-v4-positions.test.ts` | a v4 position opened, reduced by 25%, then closed    |
| `chain/test/fork-routes.test.ts`       | a routed swap: wrap → v3 → v4 → unwrap               |

## License

[MIT](LICENSE)
