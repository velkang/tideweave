import type { Context, Hono } from "hono";
import { getAddress, isAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { MAX_SWAP_PRICE_IMPACT_BPS, UNISWAP_V4_MONAD, buildMonadSwap, buildSwapApproval, isLivePairAlmostEmpty,
  monadSwapPayloadHash, quoteMonadSwap, swapApprovalPayloadHash, swapSpender, swapTokenOut,
  type SwapPair, type SwapQuoteClient } from "@tideweave/chain";
import { monadClient } from "../clients";
import { monShortfallError, walletReserve } from "../delegation";
import type { AppEnvironment, RouteDeps } from "../env";
import { jsonBody, record } from "../http";
import { RouteRejection, respond, storeIntent } from "../intent-store";
import { cachedMonUsd } from "../live-pairs";
import { isVenue, pairReadRejection, readPair, validPairId, type Venue } from "../pairs";

// Exact-input swaps in one pool. The quote is checked here and again by the signer just before it
// signs: price impact at most 5%, never in an almost-empty pool, and a minimum output set from
// the quote less the user's slippage.

const INTENT_TTL_MS = 10 * 60_000;
const DEADLINE_SECONDS = 600n;
const tokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

type Wallet = { id: string; address: Address; state: string };
type SwapClient = SwapQuoteClient & {
  getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
  getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
  estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint }): Promise<bigint>;
  call(input: { account?: Address; to: Address; data: Hex; value?: bigint; blockNumber?: bigint }): Promise<{ data?: Hex }>;
};
type SwapRequest = { venue: Venue; pairId: string; tokenIn: Address; amountIn: bigint; slippageBps: number };
export type SwapAllowance = { stage: "erc20" | "permit2"; spender: Address; allowance: string; expiration?: string };

function parseRequest(body: Record<string, unknown>): SwapRequest {
  const { venue, pairId, tokenIn, amountIn, slippageBps } = body;
  if (typeof venue !== "string" || !isVenue(venue) || typeof pairId !== "string" || !validPairId(venue, pairId) ||
      typeof tokenIn !== "string" || !isAddress(tokenIn) || typeof amountIn !== "string" ||
      !/^[1-9][0-9]*$/.test(amountIn) || typeof slippageBps !== "number" || !Number.isInteger(slippageBps) ||
      slippageBps < 0 || slippageBps > 500) throw new RouteRejection("INVALID_SWAP_REQUEST", 400);
  return { venue, pairId, tokenIn: getAddress(tokenIn), amountIn: BigInt(amountIn), slippageBps };
}

async function loadWallet(context: Context<AppEnvironment>): Promise<Wallet> {
  const wallet = await context.env.DB.prepare("SELECT id, address, state FROM managed_wallets WHERE user_id = ?1")
    .bind(context.get("user").id).first<Wallet>();
  if (!wallet) throw new RouteRejection("WALLET_NOT_FOUND", 404);
  if (wallet.state !== "active") throw new RouteRejection("WALLET_NOT_ACTIVE", 409);
  return { ...wallet, address: getAddress(wallet.address) };
}

async function setup(context: Context<AppEnvironment>, deps: RouteDeps, venue: Venue, pairId: string) {
  const wallet = await loadWallet(context);
  const client = monadClient(deps, context.env) as SwapClient;
  const safe = await client.getBlock({ blockTag: "safe" });
  if (safe.number === null || safe.hash === null) throw new RouteRejection("SAFE_BLOCK_UNAVAILABLE", 503);
  let pair: SwapPair;
  try {
    pair = await readPair({ client, db: context.env.DB, venue, id: pairId, blockNumber: safe.number });
  } catch (error) {
    const rejection = pairReadRejection(error);
    if (rejection) throw new RouteRejection(rejection.code, rejection.status);
    throw error;
  }
  const monUsd = await (deps.monUsd ?? (() => cachedMonUsd(client, deps.now())))();
  if (isLivePairAlmostEmpty(pair, monUsd)) {
    throw new RouteRejection("POOL_ALMOST_EMPTY", 422);
  }
  return { wallet, client, safe: { number: safe.number, hash: safe.hash }, pair };
}

/** The input token's balance and the allowances the venue needs, at the safe block. */
async function inputAssets(client: SwapClient, pair: SwapPair, owner: Address, token: Address, blockNumber: bigint) {
  if (token === zeroAddress) {
    return { balance: await client.getBalance({ address: owner, blockNumber }), allowances: [] as SwapAllowance[] };
  }
  const { erc20Spender, permit2Spender } = swapSpender(pair.venue);
  const [balance, erc20] = await Promise.all([
    client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner], blockNumber }),
    client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [owner, erc20Spender],
      blockNumber }),
  ]);
  const allowances: SwapAllowance[] = [{ stage: "erc20", spender: erc20Spender, allowance: String(erc20) }];
  if (permit2Spender) {
    const permit = await client.readContract({ address: UNISWAP_V4_MONAD.permit2, abi: permit2Abi,
      functionName: "allowance", args: [owner, token, permit2Spender], blockNumber }) as readonly [bigint, number, number];
    allowances.push({ stage: "permit2", spender: permit2Spender, allowance: String(permit[0]),
      expiration: String(permit[1]) });
  }
  return { balance: balance as bigint, allowances };
}

/** True when every approval covers `amount`, and any Permit2 approval outlives the swap's deadline. */
function approved(allowances: SwapAllowance[], amount: bigint, deadline: bigint) {
  return allowances.every((item) => BigInt(item.allowance) >= amount &&
    (item.stage !== "permit2" || BigInt(item.expiration ?? "0") > deadline));
}

async function quote(context: Context<AppEnvironment>, deps: RouteDeps, request: SwapRequest) {
  const { wallet, client, safe, pair } = await setup(context, deps, request.venue, request.pairId);
  let tokenOut: Address;
  try { tokenOut = swapTokenOut(pair, request.tokenIn); }
  catch { throw new RouteRejection("SWAP_TOKEN_NOT_IN_PAIR", 422); }
  let quoted;
  try {
    quoted = await quoteMonadSwap({ client, pair, tokenIn: request.tokenIn, amountIn: request.amountIn,
      blockNumber: safe.number });
  } catch {
    throw new RouteRejection("SWAP_QUOTE_UNAVAILABLE", 422);
  }
  const amountOutMinimum = quoted.amountOut * BigInt(10_000 - request.slippageBps) / 10_000n;
  if (amountOutMinimum <= 0n) throw new RouteRejection("SWAP_TOO_SMALL", 422);
  const assets = await inputAssets(client, pair, wallet.address, request.tokenIn, safe.number);
  return { wallet, client, safe, pair, tokenOut, quoted, amountOutMinimum, assets };
}

const pairKey = (pair: SwapPair) => pair.venue === "uniswap-v4"
  ? { currency0: pair.currency0, currency1: pair.currency1, fee: pair.fee, tick_spacing: pair.tickSpacing,
    hooks: pair.hooks }
  : { currency0: null, currency1: null, fee: null, tick_spacing: null, hooks: null };

/** Simulates from the wallet, then checks MON covers value, gas and any delegated reserve. */
async function simulate(client: SwapClient, wallet: Wallet, call: { to: Address; data: Hex; value: bigint },
  blockNumber: bigint, failure: string): Promise<bigint> {
  let gas: bigint;
  try {
    const request = { account: wallet.address, ...call, blockNumber };
    [, gas] = await Promise.all([client.call(request), client.estimateGas(request)]);
  } catch {
    throw new RouteRejection(failure, 422);
  }
  const [monBalance, fees, kept] = await Promise.all([client.getBalance({ address: wallet.address, blockNumber }),
    client.estimateFeesPerGas(), walletReserve(client, wallet.address, blockNumber)]);
  if (monBalance < call.value + (gas * 120n * fees.maxFeePerGas + 99n) / 100n + kept) {
    throw new RouteRejection(call.value > 0n && kept === 0n ? "INSUFFICIENT_MON" : monShortfallError(kept), 422);
  }
  return gas;
}

/** Signed in: quote, approve and prepare swaps on any venue. */
export function registerSwapRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  app.post("/v1/wallets/swaps/quote", (context) => respond(context, async () => {
    const request = parseRequest(record(await jsonBody(context)));
    const { tokenOut, quoted, amountOutMinimum, assets } = await quote(context, deps, request);
    const deadline = BigInt(Math.floor(deps.now() / 1_000)) + DEADLINE_SECONDS;
    return context.json({ tokenOut, amountOut: quoted.amountOut.toString(), amountOutMinimum: amountOutMinimum.toString(),
      priceImpactBps: quoted.priceImpactBps, tooMuchImpact: quoted.priceImpactBps > MAX_SWAP_PRICE_IMPACT_BPS,
      balance: assets.balance.toString(), allowances: assets.allowances,
      approved: approved(assets.allowances, request.amountIn, deadline) });
  }));

  app.post("/v1/wallets/swaps/prepare", (context) => respond(context, async () => {
    const body = record(await jsonBody(context));
    const request = parseRequest(body);
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 || body.idempotencyKey.length > 200) {
      throw new RouteRejection("INVALID_SWAP_REQUEST", 400);
    }
    const { wallet, client, safe, pair, tokenOut, quoted, amountOutMinimum, assets } = await quote(context, deps, request);
    if (quoted.priceImpactBps > MAX_SWAP_PRICE_IMPACT_BPS) throw new RouteRejection("PRICE_IMPACT_TOO_HIGH", 422);
    if (assets.balance < request.amountIn) throw new RouteRejection("INSUFFICIENT_TOKEN_BALANCE", 422);
    const deadline = BigInt(Math.floor(deps.now() / 1_000)) + DEADLINE_SECONDS;
    if (!approved(assets.allowances, request.amountIn, deadline)) throw new RouteRejection("SWAP_APPROVAL_REQUIRED", 422);
    const swap = buildMonadSwap({ pair, tokenIn: request.tokenIn, amountIn: request.amountIn, amountOutMinimum,
      recipient: wallet.address, deadline });
    const gas = await simulate(client, wallet, swap, safe.number, "SWAP_SIMULATION_FAILED");
    const now = deps.now();
    const stored = await storeIntent(context.env.DB, { walletId: wallet.id, automationRunId: context.get("agentRun")?.id, kind: "monad_swap",
      payloadHash: monadSwapPayloadHash(swap), idempotencyKey: body.idempotencyKey, now,
      expiresAt: Math.min(now + INTENT_TTL_MS, Number(deadline) * 1_000), table: "monad_swap_intents",
      row: { venue: pair.venue, pair_id: pair.id, ...pairKey(pair), token_in: swap.tokenIn, token_out: tokenOut,
        amount_in: swap.amountIn.toString(), amount_out_quoted: quoted.amountOut.toString(),
        amount_out_minimum: amountOutMinimum.toString(), slippage_bps: request.slippageBps,
        price_impact_bps: quoted.priceImpactBps, deadline: deadline.toString(), target: swap.to,
        calldata: swap.data, native_value: swap.value.toString(), simulation_block: Number(safe.number),
        simulation_block_hash: safe.hash, gas_estimate: gas.toString() } });
    return context.json({ ...stored, transaction: { chainId: swap.chainId, to: swap.to, data: swap.data,
      value: swap.value.toString() }, simulation: { amountOut: quoted.amountOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(), priceImpactBps: String(quoted.priceImpactBps),
      gasEstimate: gas.toString() } }, stored.replayed ? 200 : 201);
  }));

  app.post("/v1/wallets/swaps/approvals/prepare", (context) => respond(context, async () => {
    const body = record(await jsonBody(context));
    const { venue, pairId, tokenAddress, stage, amount, expiration, idempotencyKey } = body;
    if (typeof venue !== "string" || !isVenue(venue) || typeof pairId !== "string" || !validPairId(venue, pairId) ||
        typeof tokenAddress !== "string" || !isAddress(tokenAddress) || (stage !== "erc20" && stage !== "permit2") ||
        typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount) ||
        (stage === "permit2" && (typeof expiration !== "string" || !/^[1-9][0-9]*$/.test(expiration))) ||
        typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new RouteRejection("INVALID_SWAP_APPROVAL", 400);
    }
    const { wallet, client, safe, pair } = await setup(context, deps, venue, pairId);
    const seconds = BigInt(Math.floor(deps.now() / 1_000));
    const permitExpiry = stage === "permit2" ? BigInt(expiration as string) : undefined;
    if (permitExpiry !== undefined && (permitExpiry <= seconds || permitExpiry > seconds + 3n * 24n * 60n * 60n)) {
      throw new RouteRejection("INVALID_PERMIT2_EXPIRATION", 400);
    }
    let approval;
    try {
      approval = buildSwapApproval({ pair, token: getAddress(tokenAddress), stage, amount: BigInt(amount),
        expiration: permitExpiry });
    } catch (error) {
      throw new RouteRejection(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message
        : "INVALID_SWAP_APPROVAL", 422);
    }
    if (approval.stage === "permit2") {
      const assets = await inputAssets(client, pair, wallet.address, approval.token, safe.number);
      if (BigInt(assets.allowances[0].allowance) < approval.amount) throw new RouteRejection("ERC20_APPROVAL_REQUIRED", 422);
    }
    const gas = await simulate(client, wallet, approval, safe.number, "SWAP_APPROVAL_SIMULATION_FAILED");
    const now = deps.now();
    const stored = await storeIntent(context.env.DB, { walletId: wallet.id, automationRunId: context.get("agentRun")?.id, kind: "monad_swap_approval",
      payloadHash: swapApprovalPayloadHash(approval), idempotencyKey, now, expiresAt: now + INTENT_TTL_MS,
      table: "monad_swap_approval_intents", row: { venue: pair.venue, pair_id: pair.id, ...pairKey(pair),
        token: approval.token, stage: approval.stage, spender: approval.spender, amount: approval.amount.toString(),
        expiration: approval.expiration.toString(), target: approval.to, calldata: approval.data,
        simulation_block: Number(safe.number), simulation_block_hash: safe.hash, gas_estimate: gas.toString() } });
    return context.json({ ...stored, transaction: { chainId: approval.chainId, to: approval.to, data: approval.data,
      value: "0" }, simulation: { gasEstimate: gas.toString() } }, stored.replayed ? 200 : 201);
  }));
}
