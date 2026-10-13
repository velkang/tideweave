import type { Hono } from "hono";
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { MONAD_TOKENS, buildWrap, wrapPayloadHash, type MonadV3PoolClient, type WrapAction } from "@tideweave/chain";
import { monadClient } from "../clients";
import { monShortfallError, walletReserve } from "../delegation";
import type { AppEnvironment, RouteDeps } from "../env";
import { jsonBody, record } from "../http";
import { RouteRejection, respond, storeIntent } from "../intent-store";

// Wrapping MON into WMON, and back. A swap from or to native MON through a WMON pool (v3, nad.fun) runs
// one of these as its own step.

const INTENT_TTL_MS = 10 * 60_000;
const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

type Wallet = { id: string; address: Address; state: string };
type WrapClient = MonadV3PoolClient & {
  getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
  getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
  estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint }): Promise<bigint>;
  call(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint }): Promise<unknown>;
};

function parseRequest(body: Record<string, unknown>) {
  const { action, amount, idempotencyKey } = body;
  if ((action !== "wrap" && action !== "unwrap") || typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount) ||
      typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    throw new RouteRejection("INVALID_WRAP_REQUEST", 400);
  }
  return { action: action as WrapAction, amount: BigInt(amount), idempotencyKey };
}

/** Signed in: prepare a wrap or unwrap from the managed wallet. Agents may not. */
export function registerWrapRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  app.post("/v1/wallets/wrap/prepare", (context) => respond(context, async () => {
    if (context.get("agentRun")) throw new RouteRejection("AGENT_WRAP_NOT_ALLOWED", 403);
    const request = parseRequest(record(await jsonBody(context)));
    const found = await context.env.DB.prepare("SELECT id, address, state FROM managed_wallets WHERE user_id = ?1")
      .bind(context.get("user").id).first<Wallet>();
    if (!found) throw new RouteRejection("WALLET_NOT_FOUND", 404);
    if (found.state !== "active") throw new RouteRejection("WALLET_NOT_ACTIVE", 409);
    const wallet = { ...found, address: getAddress(found.address) };
    const client = monadClient(deps, context.env) as WrapClient;
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) throw new RouteRejection("SAFE_BLOCK_UNAVAILABLE", 503);
    const blockNumber = safe.number;

    if (request.action === "unwrap") {
      const held = await client.readContract({ address: MONAD_TOKENS.WMON, abi: balanceAbi, functionName: "balanceOf",
        args: [wallet.address], blockNumber }) as bigint;
      if (held < request.amount) throw new RouteRejection("INSUFFICIENT_TOKEN_BALANCE", 422);
    }
    const wrap = buildWrap({ action: request.action, amount: request.amount });
    const call = { account: wallet.address, to: wrap.to, data: wrap.data, value: wrap.value, blockNumber };
    let gas: bigint;
    try { [, gas] = await Promise.all([client.call(call), client.estimateGas(call)]); }
    catch { throw new RouteRejection("WRAP_SIMULATION_FAILED", 422); }
    // MON pays the wrapped amount and the gas, and a nad.fun-delegated wallet keeps Monad's reserve.
    const [mon, fees, kept] = await Promise.all([client.getBalance({ address: wallet.address, blockNumber }),
      client.estimateFeesPerGas(), walletReserve(client, wallet.address, blockNumber)]);
    if (mon < wrap.value + (gas * 120n * fees.maxFeePerGas + 99n) / 100n + kept) {
      throw new RouteRejection(kept === 0n && wrap.value > 0n ? "INSUFFICIENT_MON" : monShortfallError(kept), 422);
    }

    const now = deps.now();
    const stored = await storeIntent(context.env.DB, { walletId: wallet.id, kind: `monad_${request.action}`,
      payloadHash: wrapPayloadHash(wrap), idempotencyKey: request.idempotencyKey, now, expiresAt: now + INTENT_TTL_MS,
      table: "monad_wrap_intents", row: { action: wrap.action, amount: wrap.amount.toString(), calldata: wrap.data,
        native_value: wrap.value.toString(), simulation_block: Number(blockNumber), simulation_block_hash: safe.hash,
        gas_estimate: gas.toString() } });
    return context.json({ ...stored, transaction: { chainId: wrap.chainId, to: wrap.to, data: wrap.data,
      value: wrap.value.toString() }, simulation: { gasEstimate: gas.toString() } }, stored.replayed ? 200 : 201);
  }));
}
