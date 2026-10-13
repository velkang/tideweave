import type { Hono } from "hono";
import { getAddress, isAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import {
  buildMonadWithdrawal, monad, monadWithdrawalPayloadHash, erc20TransferAbi, type MonadV3PoolClient,
} from "@tideweave/chain";
import { AuthError } from "../auth";
import { monadClient } from "../clients";
import { monReserve, walletDelegate } from "../delegation";
import type { AppEnvironment, RouteDeps } from "../env";
import { jsonBody, record } from "../http";

// A withdrawal sends MON or a held token from the managed wallet to any address, authorized by the
// signed-in session like every other action. The client's random nonce makes a retry idempotent.
const EXPIRY_SECONDS = 240;

type WithdrawalRequest = { asset: Address; recipient: Address; amount: bigint; nonce: Hex };

function parseRequest(body: Record<string, unknown>): WithdrawalRequest {
  const { asset, recipient, amount, nonce } = body;
  if (typeof asset !== "string" || !isAddress(asset) ||
      typeof recipient !== "string" || !isAddress(recipient) ||
      typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount) ||
      typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    throw new AuthError("INVALID_WITHDRAWAL", 400);
  }
  return { asset: getAddress(asset), recipient: getAddress(recipient), amount: BigInt(amount), nonce: nonce as Hex };
}

/** Signed in: send MON or any ERC-20 from the managed wallet. Agents may not. */
export function registerWithdrawalRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  const { now } = deps;
  app.post("/v1/wallets/monad/withdrawals/prepare", async (context) => {
    if (context.get("agentRun")) throw new AuthError("AGENT_WITHDRAWAL_NOT_ALLOWED", 403);
    const request = parseRequest(record(await jsonBody(context)));
    const timestamp = now();
    const expiresAt = Math.floor(timestamp / 1_000) + EXPIRY_SECONDS;
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active" && wallet.state !== "paused") {
      return context.json({ error: "WALLET_NOT_ACTIONABLE" }, 409);
    }
    let withdrawal;
    try {
      withdrawal = buildMonadWithdrawal({ wallet: wallet.address, ...request, expiresAt: BigInt(expiresAt) });
    } catch {
      throw new AuthError("INVALID_WITHDRAWAL", 400);
    }
    const payloadHash = monadWithdrawalPayloadHash(withdrawal);
    const existing = await context.env.DB.prepare(
      `SELECT wi.id, wi.status, wi.payload_hash, wi.wallet_id FROM monad_withdrawal_intents mwi
       JOIN wallet_intents wi ON wi.id = mwi.intent_id WHERE mwi.nonce = ?1`,
    ).bind(withdrawal.nonce).first<{ id: string; status: string; payload_hash: Hex; wallet_id: string }>();
    if (existing) {
      if (existing.wallet_id !== wallet.id || existing.payload_hash !== payloadHash) {
        return context.json({ error: "WITHDRAWAL_NONCE_ALREADY_USED" }, 409);
      }
      return context.json({ intentId: existing.id, status: existing.status, existing: true });
    }

    const client = monadClient(deps, context.env) as
      MonadV3PoolClient & {
        getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
        getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null }>;
        getCode(input: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
        estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
        estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
        simulateContract(input: { address: Address; abi: typeof erc20TransferAbi;
          functionName: "transfer"; args: readonly [Address, bigint];
          account: Address; blockNumber?: bigint }): Promise<{ result: unknown }>;
      };
    const block = await client.getBlock({ blockTag: "safe" });
    if (block.number === null) return context.json({ error: "MONAD_SAFE_BLOCK_UNAVAILABLE" }, 503);
    const nativeBalance = await client.getBalance({ address: wallet.address, blockNumber: block.number });
    if (withdrawal.asset === zeroAddress) {
      if (nativeBalance < withdrawal.amount) {
        return context.json({ error: "INSUFFICIENT_MON" }, 422);
      }
    } else {
      const code = await client.getCode({ address: withdrawal.asset, blockNumber: block.number });
      if (!code || code === "0x") return context.json({ error: "ASSET_NOT_CONTRACT" }, 422);
      const tokenBalance = await client.readContract({ address: withdrawal.asset,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf", args: [wallet.address], blockNumber: block.number });
      if (typeof tokenBalance !== "bigint" || tokenBalance < withdrawal.amount) {
        return context.json({ error: "INSUFFICIENT_TOKEN_BALANCE" }, 422);
      }
      const simulation = await client.simulateContract({ address: withdrawal.asset,
        abi: erc20TransferAbi,
        functionName: "transfer", args: [withdrawal.recipient, withdrawal.amount],
        account: wallet.address, blockNumber: block.number });
      if (simulation.result !== true) {
        return context.json({ error: "TOKEN_TRANSFER_FAILED" }, 422);
      }
    }
    const [gas, fees] = await Promise.all([
      client.estimateGas({ account: wallet.address, to: withdrawal.to,
        data: withdrawal.data, value: withdrawal.value }),
      client.estimateFeesPerGas(),
    ]).catch(() => { throw new AuthError("WITHDRAWAL_GAS_ESTIMATE_FAILED", 422); });
    const feeReserve = (gas * 120n * fees.maxFeePerGas + 99n) / 100n;
    // A wallet delegated for nad.fun batches must keep Monad's 10 MON reserve; clearing the
    // delegation first allows withdrawing all of it.
    const delegated = await walletDelegate(client, wallet.address, block.number) !== null;
    if (nativeBalance < withdrawal.value + feeReserve + monReserve(delegated)) {
      return context.json({ error: delegated ? "INSUFFICIENT_MON_RESERVE" : "INSUFFICIENT_MON_FOR_GAS" }, 422);
    }
    const intentId = `monad_withdrawal_${crypto.randomUUID()}`;
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents
         (id, wallet_id, kind, payload_hash, status, expires_at, created_at, updated_at)
         VALUES (?1, ?2, 'monad_withdrawal', ?3, 'pending', ?4, ?5, ?5)`,
      ).bind(intentId, wallet.id, payloadHash, expiresAt * 1_000, timestamp),
      context.env.DB.prepare(
        `INSERT INTO monad_withdrawal_intents
         (intent_id, chain_id, asset_address, recipient, amount, nonce, expires_at,
          target_address, calldata, native_value, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(intentId, monad.id, withdrawal.asset, withdrawal.recipient,
        withdrawal.amount.toString(), withdrawal.nonce, expiresAt, withdrawal.to,
        withdrawal.data, withdrawal.value.toString(), timestamp),
    ]);
    return context.json({ intentId, status: "pending", gasEstimate: gas.toString(),
      feeReserve: feeReserve.toString() }, 201);
  });
}
