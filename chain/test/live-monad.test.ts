import { createPublicClient, getAddress, http } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, amountsForLiquidity, discoverPairsForToken, monad, readMonUsd, readMonadV4Position, readNadPair,
  readNadPosition, readV4Fees, type MonadV3PoolClient, type StateViewClient } from "../src";

// Read-only checks against Monad mainnet; run with LIVE_MONAD_RPC=true.
const live = process.env.LIVE_MONAD_RPC === "true";
// A graduated nad.fun pair that held liquidity on 2026-10-07.
const GRADUATED_PAIR = getAddress("0xbd1BEbC1CA6cE1955eD5Ec466b89da58051d8f4E");
const GRADUATED_TOKEN = getAddress("0x7D1ca08C16A46837B02a25112d188B6dF1D17777");

describe.skipIf(!live)("Monad mainnet reads", () => {
  const client = createPublicClient({ chain: monad, transport: http(process.env.MONAD_RPC_URL),
    batch: { multicall: true } }) as unknown as MonadV3PoolClient;

  it("reads a graduated nad.fun pair and an empty position", async () => {
    const pair = await readNadPair({ client, pairAddress: GRADUATED_PAIR });
    expect(pair.memeToken).toBe(GRADUATED_TOKEN);
    expect(pair.token0.address).toBe(MONAD_TOKENS.WMON);
    expect(pair.totalSupply).toBeGreaterThan(0n);
    const position = await readNadPosition({ client, pair, owner: "0x000000000000000000000000000000000000dEaD" });
    expect(position.lpBalance).toBe(1_000n);
  }, 30_000);

  it("finds the graduated token's nad.fun pair by reading the factories", async () => {
    const found = await discoverPairsForToken({ client, token: GRADUATED_TOKEN });
    expect(found.nadfun).toEqual([GRADUATED_PAIR]);
  }, 60_000);

  it("reads a plausible MON price from the reference pool", async () => {
    const price = await readMonUsd(client);
    expect(price).toBeGreaterThan(0.0001);
    expect(price).toBeLessThan(1_000);
  }, 30_000);

  it("reads a live v4 position's holdings and uncollected fees", async () => {
    // A native-MON / MON.b.gMON position opened through Tideweave on 2026-10-08.
    const owner = getAddress("0x90e242E0ABc00Eb8bceBe3Eb91a9B0AE7e7799ef");
    const position = await readMonadV4Position({ client, owner, tokenId: 636_714n });
    const amounts = amountsForLiquidity({ sqrtPriceX96: position.pool.sqrtPriceX96, tickLower: position.tickLower,
      tickUpper: position.tickUpper, liquidity: position.liquidity });
    expect(amounts.amount0 + amounts.amount1).toBeGreaterThan(10n ** 18n);
    const fees = await readV4Fees({ client: client as unknown as StateViewClient, poolId: position.pool.id,
      tokenId: 636_714n, tickLower: position.tickLower, tickUpper: position.tickUpper });
    expect(fees.amount0).toBeGreaterThanOrEqual(0n);
    expect(fees.amount1).toBeLessThan(10n ** 18n);
  }, 30_000);
});

