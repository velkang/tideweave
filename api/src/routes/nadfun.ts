import type { Context, Hono } from "hono";
import { getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";
import { MONAD_TOKENS, SIMPLE_7702_ACCOUNT, buildNadAdd, buildNadDelegationClear, buildNadRemove,
  nadBatchPayloadHash, readNadPair, type MonadNadPair, type MonadV3PoolClient, type NadAdd,
  type NadDelegationClear, type NadRemove } from "@tideweave/chain";
import { monadClient } from "../clients";
import { AUTHORIZATION_GAS, asDelegated, monReserve, walletDelegate } from "../delegation";
import type { AppEnvironment, RouteDeps } from "../env";
import { jsonBody, record } from "../http";
import { RouteRejection, respond, storeIntent } from "../intent-store";
import { pairReadRejection } from "../pairs";

// nad.fun liquidity runs as one EIP-7702 batch. The first one also delegates the wallet to
// Simple7702Account; it then has to keep Monad's 10 MON reserve until the delegation is cleared.

const INTENT_TTL_MS = 10 * 60_000;
const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

type Wallet = { id: string; address: Address; state: string };
type BatchClient = MonadV3PoolClient & {
  getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
  getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
  call(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint;
    stateOverride?: ReturnType<typeof asDelegated> }): Promise<unknown>;
  estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint;
    stateOverride?: ReturnType<typeof asDelegated> }): Promise<bigint>;
};
type Batch = NadAdd | NadRemove | NadDelegationClear;
type Prepared = { wallet: Wallet; batch: Batch; safe: { number: bigint; hash: Hex }; delegate: Address | null;
  gasEstimate: bigint; row: Record<string, string | number | null> };

const positive = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const amount = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const validKey = (value: unknown): value is string => typeof value === "string" && value.length >= 16 &&
  value.length <= 200;
const validSlippage = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) &&
  value >= 0 && value <= 500;


async function loadWallet(context: Context<AppEnvironment>, allowPaused: boolean): Promise<Wallet> {
  const wallet = await context.env.DB.prepare("SELECT id, address, state FROM managed_wallets WHERE user_id = ?1")
    .bind(context.get("user").id).first<Wallet>();
  if (!wallet) throw new RouteRejection("WALLET_NOT_FOUND", 404);
  if (wallet.state !== "active" && !(allowPaused && wallet.state === "paused")) {
    throw new RouteRejection(allowPaused ? "WALLET_NOT_SIGNABLE" : "WALLET_NOT_ACTIVE", 409);
  }
  return { ...wallet, address: getAddress(wallet.address) };
}

async function safeBlock(client: BatchClient) {
  const safe = await client.getBlock({ blockTag: "safe" });
  if (safe.number === null || safe.hash === null) throw new RouteRejection("SAFE_BLOCK_UNAVAILABLE", 503);
  return { number: safe.number, hash: safe.hash };
}

async function livePair(client: BatchClient, pairAddress: Address, blockNumber: bigint): Promise<MonadNadPair> {
  try {
    return await readNadPair({ client, pairAddress, blockNumber });
  } catch (error) {
    const rejection = pairReadRejection(error);
    if (rejection) throw new RouteRejection(rejection.code, 422);
    throw error;
  }
}

/**
 * Simulates the batch as the wallet would run it (delegated, even before its first batch),
 * checks MON covers the gas plus the reserve, and returns the gas the transaction will need.
 */
async function simulate(client: BatchClient, wallet: Wallet, batch: Batch, delegate: Address | null,
  blockNumber: bigint, extraMon: bigint): Promise<bigint> {
  const target = batch.kind === "clear" ? null : SIMPLE_7702_ACCOUNT;
  const authorizes = batch.kind === "clear" || delegate === null;
  const call = { account: wallet.address, to: wallet.address, data: batch.data, value: 0n, blockNumber,
    ...(target && delegate === null ? { stateOverride: asDelegated(wallet.address, target) } : {}) };
  let gas: bigint;
  try {
    const [, estimate] = await Promise.all([batch.kind === "clear" ? null : client.call(call), client.estimateGas(call)]);
    gas = estimate + (authorizes ? AUTHORIZATION_GAS : 0n);
  } catch {
    throw new RouteRejection("NAD_BATCH_SIMULATION_FAILED", 422);
  }
  const [monBalance, fees] = await Promise.all([client.getBalance({ address: wallet.address, blockNumber }),
    client.estimateFeesPerGas()]);
  const gasCost = (gas * 120n * fees.maxFeePerGas + 99n) / 100n;
  if (monBalance < extraMon + gasCost + monReserve(true)) throw new RouteRejection("INSUFFICIENT_MON_RESERVE", 422);
  return gas;
}

async function store(context: Context<AppEnvironment>, deps: RouteDeps, kind: string, prepared: Prepared,
  idempotencyKey: string) {
  const { wallet, batch } = prepared;
  const now = deps.now();
  const stored = await storeIntent(context.env.DB, { walletId: wallet.id, kind, payloadHash: nadBatchPayloadHash(batch),
    idempotencyKey, now, expiresAt: now + INTENT_TTL_MS, table: "monad_nadfun_intents",
    row: { ...prepared.row, calldata: batch.data, delegate_before: prepared.delegate,
      simulation_block: Number(prepared.safe.number), simulation_block_hash: prepared.safe.hash,
      gas_estimate: prepared.gasEstimate.toString() } });
  if (stored.replayed) return context.json(stored);
  return context.json({ intentId: stored.intentId, status: stored.status,
    transaction: { chainId: batch.chainId, to: batch.to, data: batch.data, value: "0",
      delegation: batch.kind === "clear" ? batch.delegate : prepared.delegate === null ? SIMPLE_7702_ACCOUNT : null },
    simulation: { gasEstimate: prepared.gasEstimate.toString(), blockHash: prepared.safe.hash,
      ...(batch.kind === "add" ? { amount0: batch.amount0.toString(), amount1: batch.amount1.toString(),
        minLiquidity: batch.minLiquidity.toString() } : {}),
      ...(batch.kind === "remove" ? { liquidity: batch.liquidity.toString(), amount0Min: batch.amount0Min.toString(),
        amount1Min: batch.amount1Min.toString() } : {}) },
    monReserve: monReserve(batch.kind !== "clear").toString() }, 201);
}

const pairRow = (pair: MonadNadPair) => ({ pair_address: pair.id, token0_address: pair.token0.address,
  token1_address: pair.token1.address, token0_decimals: pair.token0.decimals, token1_decimals: pair.token1.decimals,
  meme_token: pair.memeToken, reserve0: pair.reserve0.toString(), reserve1: pair.reserve1.toString(),
  total_supply: pair.totalSupply.toString() });

async function prepareAdd(context: Context<AppEnvironment>, deps: RouteDeps, body: Record<string, unknown>,
  pairAddress: Address): Promise<Prepared> {
  if (!positive(body.amount0Desired) || !positive(body.amount1Desired) || !validSlippage(body.slippageBps) ||
      (body.wrapAmount !== undefined && !amount(body.wrapAmount))) throw new RouteRejection("INVALID_NAD_DEPOSIT", 400);
  const wallet = await loadWallet(context, false);
  const client = monadClient(deps, context.env) as BatchClient;
  const safe = await safeBlock(client);
  const pair = await livePair(client, pairAddress, safe.number);
  const balanceOf = (token: Address) => client.readContract({ address: token, abi: balanceAbi, functionName: "balanceOf",
    args: [wallet.address], blockNumber: safe.number }) as Promise<bigint>;
  const [lpBefore, balance0, balance1, delegate] = await Promise.all([balanceOf(pair.id),
    balanceOf(pair.token0.address), balanceOf(pair.token1.address), walletDelegate(client, wallet.address, safe.number)]);
  if (delegate !== null && delegate !== SIMPLE_7702_ACCOUNT) throw new RouteRejection("DELEGATION_UNEXPECTED", 409);
  const wrapAmount = BigInt((body.wrapAmount as string | undefined) ?? "0");
  let batch: NadAdd;
  try {
    batch = buildNadAdd({ pair, wallet: wallet.address, amount0Desired: BigInt(body.amount0Desired),
      amount1Desired: BigInt(body.amount1Desired), slippageBps: body.slippageBps, lpBefore, wrapAmount });
  } catch (error) {
    throw new RouteRejection(error instanceof Error && error.message.startsWith("NAD_") ? error.message
      : "INVALID_NAD_DEPOSIT", 422);
  }
  // The WMON side can be topped up by wrapping MON inside the batch.
  const wmon0 = pair.token0.address === MONAD_TOKENS.WMON;
  if (balance0 + (wmon0 ? wrapAmount : 0n) < batch.amount0 || balance1 + (wmon0 ? 0n : wrapAmount) < batch.amount1) {
    throw new RouteRejection("INSUFFICIENT_TOKEN_BALANCE", 422);
  }
  const gasEstimate = await simulate(client, wallet, batch, delegate, safe.number, wrapAmount);
  return { wallet, batch, safe, delegate, gasEstimate, row: { action: "add", ...pairRow(pair),
    amount0_desired: String(body.amount0Desired), amount1_desired: String(body.amount1Desired),
    wrap_amount: wrapAmount.toString(), lp_before: lpBefore.toString(), slippage_bps: body.slippageBps } };
}

async function prepareRemove(context: Context<AppEnvironment>, deps: RouteDeps, body: Record<string, unknown>,
  pairAddress: Address): Promise<Prepared> {
  if ((body.liquidity !== undefined && !positive(body.liquidity)) || !validSlippage(body.slippageBps)) {
    throw new RouteRejection("INVALID_NAD_WITHDRAWAL", 400);
  }
  const wallet = await loadWallet(context, true);
  const client = monadClient(deps, context.env) as BatchClient;
  const safe = await safeBlock(client);
  const pair = await livePair(client, pairAddress, safe.number);
  const balanceOf = (token: Address) => client.readContract({ address: token, abi: balanceAbi, functionName: "balanceOf",
    args: [wallet.address], blockNumber: safe.number }) as Promise<bigint>;
  const [lp, balance0, balance1, delegate] = await Promise.all([balanceOf(pair.id), balanceOf(pair.token0.address),
    balanceOf(pair.token1.address), walletDelegate(client, wallet.address, safe.number)]);
  if (delegate !== null && delegate !== SIMPLE_7702_ACCOUNT) throw new RouteRejection("DELEGATION_UNEXPECTED", 409);
  const liquidity = body.liquidity === undefined ? lp : BigInt(body.liquidity as string);
  if (liquidity <= 0n || liquidity > lp) throw new RouteRejection("INSUFFICIENT_LP_BALANCE", 422);
  let batch: NadRemove;
  try {
    batch = buildNadRemove({ pair, wallet: wallet.address, liquidity, slippageBps: body.slippageBps,
      balance0Before: balance0, balance1Before: balance1 });
  } catch (error) {
    throw new RouteRejection(error instanceof Error && error.message.startsWith("NAD_") ? error.message
      : "INVALID_NAD_WITHDRAWAL", 422);
  }
  const gasEstimate = await simulate(client, wallet, batch, delegate, safe.number, 0n);
  return { wallet, batch, safe, delegate, gasEstimate, row: { action: "remove", ...pairRow(pair),
    liquidity: liquidity.toString(), balance0_before: balance0.toString(), balance1_before: balance1.toString(),
    slippage_bps: body.slippageBps } };
}

async function prepareClear(context: Context<AppEnvironment>, deps: RouteDeps): Promise<Prepared> {
  const wallet = await loadWallet(context, true);
  const client = monadClient(deps, context.env) as BatchClient;
  const safe = await safeBlock(client);
  const delegate = await walletDelegate(client, wallet.address, safe.number);
  if (delegate === null) throw new RouteRejection("NOT_DELEGATED", 409);
  const batch = buildNadDelegationClear({ wallet: wallet.address });
  const gasEstimate = await simulate(client, wallet, batch, delegate, safe.number, 0n);
  return { wallet, batch, safe, delegate, gasEstimate, row: { action: "clear" } };
}


/** Signed in: prepare nad.fun deposits and exits, and clear the wallet's delegation. */
export function registerNadfunRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  for (const [action, kind] of [["deposit", "monad_nadfun_add"], ["withdraw", "monad_nadfun_remove"]] as const) {
    app.post(`/v1/wallets/nadfun/:pair/${action}/prepare`, (context) => respond(context, async () => {
      const pairAddress = context.req.param("pair");
      const body = record(await jsonBody(context));
      if (!isAddress(pairAddress) || !validKey(body.idempotencyKey)) {
        throw new RouteRejection(action === "deposit" ? "INVALID_NAD_DEPOSIT" : "INVALID_NAD_WITHDRAWAL", 400);
      }
      const prepared = action === "deposit" ? await prepareAdd(context, deps, body, getAddress(pairAddress))
        : await prepareRemove(context, deps, body, getAddress(pairAddress));
      return store(context, deps, kind, prepared, body.idempotencyKey);
    }));
  }

  app.post("/v1/wallets/delegation/clear/prepare", (context) => respond(context, async () => {
    const body = record(await jsonBody(context));
    if (!validKey(body.idempotencyKey)) throw new RouteRejection("INVALID_DELEGATION_CLEAR", 400);
    return store(context, deps, "monad_delegation_clear", await prepareClear(context, deps), body.idempotencyKey);
  }));
}
