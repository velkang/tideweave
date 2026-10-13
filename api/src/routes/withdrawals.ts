import type { Hono } from "hono";
import { getAddress, isAddress, parseAbi, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import {
  buildMonadWithdrawal, monad, monadWithdrawalDomain, monadWithdrawalMessage,
  monadWithdrawalPayloadHash, monadWithdrawalTypes, erc20TransferAbi, type MonadV3PoolClient,
} from "@tideweave/chain";
import { AuthError } from "../auth";
import { monadClient } from "../clients";
import { monReserve, walletDelegate } from "../delegation";
import type { AppEnvironment, RouteDeps } from "../env";
import { jsonBody, record } from "../http";

/** Owner-signed withdrawals of MON or any ERC-20 from the managed wallet. */
export function registerWithdrawalRoutes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  const { now } = deps;
  app.post("/v1/wallets/monad/withdrawals/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if (typeof body.asset !== "string" || !isAddress(body.asset) ||
        typeof body.recipient !== "string" || !isAddress(body.recipient) ||
        typeof body.amount !== "string" || !/^[1-9][0-9]*$/.test(body.amount) ||
        typeof body.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.nonce) ||
        typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature) ||
        typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)) {
      throw new AuthError("INVALID_WITHDRAWAL", 400);
    }
    const timestamp = now();
    if (body.expiresAt <= Math.floor(timestamp / 1_000) + 30 ||
        body.expiresAt > Math.floor(timestamp / 1_000) + 5 * 60) {
      throw new AuthError("WITHDRAWAL_AUTHORIZATION_EXPIRED", 400);
    }
    const wallet = await context.env.DB.prepare(
      `SELECT mw.id, mw.address, mw.state, u.owner_address
       FROM managed_wallets mw JOIN users u ON u.id = mw.user_id
       WHERE mw.user_id = ?1`,
    ).bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string; owner_address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active" && wallet.state !== "paused") {
      return context.json({ error: "WALLET_NOT_ACTIONABLE" }, 409);
    }
    let withdrawal;
    try {
      withdrawal = buildMonadWithdrawal({ wallet: wallet.address,
        asset: getAddress(body.asset), recipient: getAddress(body.recipient),
        amount: BigInt(body.amount), nonce: body.nonce as Hex,
        expiresAt: BigInt(body.expiresAt) });
    } catch {
      throw new AuthError("INVALID_WITHDRAWAL", 400);
    }
    const validSignature = await verifyTypedData({ address: wallet.owner_address,
      domain: monadWithdrawalDomain, types: monadWithdrawalTypes,
      primaryType: "MonadWithdrawal", message: monadWithdrawalMessage(withdrawal),
      signature: body.signature as Hex }).catch(() => false);
    if (!validSignature) throw new AuthError("WITHDRAWAL_SIGNATURE_INVALID", 403);
    const payloadHash = monadWithdrawalPayloadHash(withdrawal, body.signature as Hex);
    const existing = await context.env.DB.prepare(
      `SELECT wi.id, wi.status, wi.payload_hash FROM monad_withdrawal_intents mwi
       JOIN wallet_intents wi ON wi.id = mwi.intent_id WHERE mwi.nonce = ?1`,
    ).bind(withdrawal.nonce).first<{ id: string; status: string; payload_hash: Hex }>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
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
      ).bind(intentId, wallet.id, payloadHash, body.expiresAt * 1_000, timestamp),
      context.env.DB.prepare(
        `INSERT INTO monad_withdrawal_intents
         (intent_id, chain_id, asset_address, recipient, amount, owner_address,
          owner_signature, nonce, signature_expires_at, target_address,
          calldata, native_value, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(intentId, monad.id, withdrawal.asset, withdrawal.recipient,
        withdrawal.amount.toString(), wallet.owner_address, body.signature,
        withdrawal.nonce, body.expiresAt, withdrawal.to, withdrawal.data,
        withdrawal.value.toString(), timestamp),
    ]);
    return context.json({ intentId, status: "pending", gasEstimate: gas.toString(),
      feeReserve: feeReserve.toString() }, 201);
  });
}
