import type { Context, Hono } from "hono";
import { getAddress, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { UNISWAP_V3_MONAD, UNISWAP_V4_MONAD, readDelegate, readMonUsd, readMonadV3Pool, readMonadV4TokenAssets,
  readNadPair, type MonadV3PoolClient } from "@tideweave/chain";
import { UsdPriceResolver } from "../pricing";
import { monadClient } from "../clients";
import { cachedMonUsd, liveListedPairs } from "../live-pairs";
import type { AppEnvironment, Bindings, RouteDeps } from "../env";
import { erc20Abi } from "../http";
import { describeNad, describeRanged, listNadPositions, listV3Positions, listV4Positions, type PositionClient,
  type RangedPosition, type RangedVenue } from "../positions";
import { isPoolId, isVenue, jsonSafe, listItemFromPair, listItemFromRow, pairReadRejection, readPair,
  validPairId, type AnyPair, type ListedRow, type Venue } from "../pairs";

const PAGE = 25;
const nativeBalanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

// D1 bills every row read, so each kind of search reads through an index: browsing walks each
// table's created_block index, an address is an equality lookup, and a symbol matches from its
// start as a range on the symbol indexes (a "contains" LIKE would read every pair).
function listSql(query: "none" | "address" | "symbol") {
  const match = (key: string, token0: string, token1: string) => query === "none" ? ""
    : query === "address" ? `AND (${token0} = ?1 OR ${token1} = ?1 OR ${key} = ?1)`
      : `AND ((token0_symbol COLLATE NOCASE >= ?1 AND token0_symbol COLLATE NOCASE < ?2)
          OR (token1_symbol COLLATE NOCASE >= ?1 AND token1_symbol COLLATE NOCASE < ?2))`;
  return `SELECT 'uniswap-v3' AS venue, pool_address AS id, token0_address, token0_symbol, token0_decimals,
      token1_address, token1_symbol, token1_decimals, fee, tick_spacing, NULL AS hooks, sqrt_price_x96, tick,
      liquidity, NULL AS reserve0, NULL AS reserve1, NULL AS meme_token, created_block, updated_at
    FROM monad_v3_pool_directory
    WHERE liquidity != '0' ${match("pool_address", "token0_address", "token1_address")}
    UNION ALL
    SELECT 'uniswap-v4', pool_id, currency0, token0_symbol, token0_decimals,
      currency1, token1_symbol, token1_decimals, fee, tick_spacing, hooks, sqrt_price_x96, tick,
      liquidity, NULL, NULL, NULL, created_block, updated_at
    FROM monad_v4_pool_directory
    WHERE liquidity != '0' ${match("pool_id", "currency0", "currency1")}
    UNION ALL
    SELECT 'nadfun-v2', pair_address, token0_address, token0_symbol, token0_decimals,
      token1_address, token1_symbol, token1_decimals, NULL, NULL, NULL, NULL, NULL,
      liquidity, reserve0, reserve1, meme_token, created_block, updated_at
    FROM monad_nadfun_pair_directory
    WHERE liquidity != '0' ${match("pair_address", "token0_address", "token1_address")}
    ORDER BY created_block DESC, id
    LIMIT ${PAGE + 1} OFFSET ?3`;
}

/** Asks the indexer to find and store a token's pairs through each factory. */
async function discover(env: Bindings, token: Address) {
  if (!env.INDEXER) return;
  try {
    const response = await env.INDEXER.fetch(new Request("http://tideweave-indexer/internal/v1/pools/discover", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddress: token }),
    }));
    if (!response.ok) console.warn("Pair discovery failed", token, response.status);
  } catch (error) {
    // A search still lists what is already known.
    console.warn("Pair discovery unavailable", token, error);
  }
}

/** A pasted pool or pair address that is not listed: read it straight from the chain. */
async function readUnlisted(client: MonadV3PoolClient, address: Address, blockNumber?: bigint): Promise<AnyPair | null> {
  for (const read of [() => readMonadV3Pool({ client, poolAddress: address, blockNumber }),
    () => readNadPair({ client, pairAddress: address, blockNumber })]) {
    try {
      return await read();
    } catch (error) {
      if (!pairReadRejection(error)) throw error;
    }
  }
  return null;
}

async function listPairs(context: Context<AppEnvironment>, deps: RouteDeps) {
  const query = (context.req.query("q") ?? "").trim().slice(0, 80);
  const offsetValue = Number(context.req.query("offset") ?? "0");
  const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? Math.min(offsetValue, 10_000) : 0;
  const kind = query === "" ? "none" : isAddress(query) || isPoolId(query) ? "address" : "symbol";
  const needle = isAddress(query) ? getAddress(query) : query;
  const select = () => context.env.DB.prepare(listSql(kind))
    // ?2 ends the symbol range: the search text followed by the highest character.
    .bind(needle, `${needle}\u{10FFFF}`, offset).all<ListedRow>();
  if (isAddress(query) && offset === 0) await discover(context.env, getAddress(query));
  const rows = (await select()).results ?? [];
  const client = monadClient(deps, context.env);
  const price = deps.monUsd ?? (() => cachedMonUsd(client, deps.now()));
  if (rows.length === 0 && isAddress(query) && offset === 0) {
    try {
      const pair = await readUnlisted(client, getAddress(query));
      const pools = pair ? await liveListedPairs(client, [listItemFromPair(pair)], price) : [];
      return context.json({ pools, nextOffset: null });
    } catch (error) {
      console.warn("Pasted address read failed", query, error);
    }
  }
  // Paging follows the stored rows; a page can show fewer pairs once almost-empty ones are left out.
  const pools = await liveListedPairs(client, rows.slice(0, PAGE).map(listItemFromRow), price);
  return context.json({ pools, nextOffset: rows.length > PAGE ? offset + PAGE : null });
}

/** Public: the one Explore list and a live read of one pair. */
export function registerExploreRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  app.get("/v1/pairs", (context) => listPairs(context, deps));

  // The public link needs only a pool identity; chain readers verify its canonical venue.
  app.get("/v1/pairs/:id", async (context) => {
    const id = context.req.param("id");
    if (!isAddress(id) && !isPoolId(id)) return context.json({ error: "INVALID_PAIR" }, 400);
    try {
      const client = monadClient(deps, context.env);
      const blockNumber = context.req.query('safe') === 'true'
        ? (await (client as AssetClient).getBlock({ blockTag: 'safe' })).number : undefined;
      if (blockNumber === null) return context.json({ error: 'SAFE_BLOCK_UNAVAILABLE' }, 503);
      const pool = isPoolId(id)
        ? await readPair({ client, db: context.env.DB, venue: "uniswap-v4", id: id.toLowerCase(), blockNumber })
        : await readUnlisted(client, getAddress(id), blockNumber);
      if (!pool) return context.json({ error: "POOL_NOT_FOUND" }, 404);
      return context.json({ pool: jsonSafe(pool) });
    } catch (error) {
      const rejection = pairReadRejection(error);
      if (rejection) return context.json({ error: rejection.code }, rejection.status);
      console.error("Pair read failed", id, error);
      return context.json({ error: "PAIR_NOT_AVAILABLE" }, 502);
    }
  });

  app.get("/v1/pairs/:venue/:id", async (context) => {
    const venue = context.req.param("venue");
    const id = context.req.param("id");
    if (!isVenue(venue) || !validPairId(venue, id)) return context.json({ error: "INVALID_PAIR" }, 400);
    try {
      const client = monadClient(deps, context.env);
      const blockNumber = context.req.query('safe') === 'true'
        ? (await (client as AssetClient).getBlock({ blockTag: 'safe' })).number : undefined;
      if (blockNumber === null) return context.json({ error: 'SAFE_BLOCK_UNAVAILABLE' }, 503);
      const pool = await readPair({ client, db: context.env.DB, venue, id, blockNumber });
      return context.json({ pool: jsonSafe(pool) });
    } catch (error) {
      const rejection = pairReadRejection(error);
      if (rejection) return context.json({ error: rejection.code }, rejection.status);
      console.error("Pair read failed", venue, id, error);
      return context.json({ error: "PAIR_NOT_AVAILABLE" }, 502);
    }
  });
}

type AssetClient = MonadV3PoolClient & {
  getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null }>;
  getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
};

/** What each venue needs approved before a deposit, with the current allowances. */
async function approvals(client: AssetClient, venue: Venue, pair: AnyPair, owner: Address, blockNumber: bigint) {
  const tokens = [pair.token0, pair.token1].filter((token) => token.address !== zeroAddress);
  if (venue === "nadfun-v2") return [];
  if (venue === "uniswap-v3") {
    return Promise.all(tokens.map(async (token) => ({ token: token.address, stage: "erc20" as const,
      spender: UNISWAP_V3_MONAD.nonfungiblePositionManager,
      allowance: String(await client.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance",
        args: [owner, UNISWAP_V3_MONAD.nonfungiblePositionManager], blockNumber })) })));
  }
  const layers = await Promise.all(tokens.map(async (token) => {
    const assets = await readMonadV4TokenAssets({ client, owner, token: token.address, blockNumber });
    return [
      { token: token.address, stage: "erc20" as const, spender: UNISWAP_V4_MONAD.permit2,
        allowance: assets.erc20Allowance.toString() },
      { token: token.address, stage: "permit2" as const, spender: UNISWAP_V4_MONAD.positionManager,
        allowance: assets.permit2Allowance.toString(), expiration: assets.permit2Expiration.toString() },
    ];
  }));
  return layers.flat();
}

/** Signed in: one pair's balances, approvals and delegation state for the managed wallet. */
export function registerExploreWalletRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  app.get("/v1/wallets/pairs/:venue/:id/assets", async (context) => {
    const venue = context.req.param("venue");
    const id = context.req.param("id");
    if (!isVenue(venue) || !validPairId(venue, id)) return context.json({ error: "INVALID_PAIR" }, 400);
    const wallet = await context.env.DB.prepare(
      "SELECT id, address FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    ).bind(context.get("user").id).first<{ id: string; address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    let manualPending = false;
    if (context.get('agentRun')) {
      const pending = await context.env.DB.prepare("SELECT id FROM mainnet_transaction_attempts WHERE wallet_id = ?1 AND status = 'submitted' LIMIT 1")
        .bind(wallet.id).first<{ id: string }>();
      if (pending) {
        const response = await context.env.SIGNER.fetch(new Request('https://tideweave-signer/internal/v1/attempts/reconcile-mainnet', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: pending.id }),
        })).catch(() => null);
        const settled = response?.ok ? await response.json().catch(() => null) as { status?: string } | null : null;
        manualPending = settled?.status !== 'confirmed';
      }
    }
    const client = monadClient(deps, context.env) as AssetClient;
    try {
      const block = await client.getBlock({ blockTag: "safe" });
      if (block.number === null) return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
      const blockNumber = block.number;
      const pair = await readPair({ client, db: context.env.DB, venue, id, blockNumber });
      const balanceOf = async (token: Address) => token === zeroAddress
        ? client.getBalance({ address: wallet.address, blockNumber })
        : client.readContract({ address: token, abi: nativeBalanceAbi, functionName: "balanceOf",
          args: [wallet.address], blockNumber }) as Promise<bigint>;
      const [balance0, balance1, monBalance, delegate, required] = await Promise.all([
        balanceOf(pair.token0.address), balanceOf(pair.token1.address),
        client.getBalance({ address: wallet.address, blockNumber }),
        readDelegate(client, wallet.address, blockNumber),
        approvals(client, venue, pair, wallet.address, blockNumber),
      ]);
      return context.json({ venue, id: pair.id, manualPending, walletAddress: wallet.address,
        token0: { ...pair.token0, balance: String(balance0) }, token1: { ...pair.token1, balance: String(balance1) },
        monBalance: monBalance.toString(), delegate, approvals: required, blockNumber: blockNumber.toString() });
    } catch (error) {
      const rejection = pairReadRejection(error);
      if (rejection) return context.json({ error: rejection.code }, rejection.status);
      console.error("Pair assets unavailable", venue, id, error);
      return context.json({ error: "PAIR_ASSETS_UNAVAILABLE" }, 502);
    }
  });

  app.get("/v1/wallets/positions", async (context) => {
    const page = Number(context.req.query("page") ?? "0");
    if (!Number.isSafeInteger(page) || page < 0 || page > 1000) return context.json({ error: "INVALID_PAGE" }, 400);
    const wallet = await context.env.DB.prepare(
      "SELECT id, address FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    ).bind(context.get("user").id).first<{ id: string; address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    const client = monadClient(deps, context.env) as AssetClient & PositionClient;
    try {
      const block = await client.getBlock({ blockTag: "safe" });
      if (block.number === null) return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
      const input = { db: context.env.DB, client, walletId: wallet.id, owner: wallet.address,
        blockNumber: block.number, page };
      const [v3, v4, nad, monUsd] = await Promise.all([listV3Positions(input), listV4Positions(input),
        page === 0 ? listNadPositions(input) : [], (deps.monUsd ?? (() => readMonUsd(client, block.number!).catch(() => null)))()]);
      const blockNumber = block.number;
      const pricing = new UsdPriceResolver(context.env.DB, client, blockNumber, monUsd);
      const ranged = (venue: RangedVenue) => async (position: RangedPosition & { transactionHash: string }) => ({
        ...await describeRanged({ venue, position, owner: wallet.address, client, blockNumber,
          pricing }), transactionHash: position.transactionHash });
      const positions = [
        ...await Promise.all(v3.positions.map(ranged("uniswap-v3"))),
        ...await Promise.all(v4.positions.map(ranged("uniswap-v4"))),
        ...await Promise.all(nad.map(async (position) => ({ ...await describeNad(position, pricing), transactionHash: null }))),
      ];
      return context.json({ positions: jsonSafe(positions), page, hasMore: v3.hasMore || v4.hasMore,
        blockNumber: block.number.toString() });
    } catch (error) {
      console.error("Position list failed", error);
      return context.json({ error: "POSITIONS_UNAVAILABLE" }, 502);
    }
  });
}
