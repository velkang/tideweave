import type { Hono } from "hono";
import { decodeFunctionResult, getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  withdrawalMinimums,  buildMonadV4Approval, buildMonadV4Mint, buildMonadV4PositionAction, monadV4ApprovalPayloadHash,
  monadV4MintPayloadHash, monadV4PositionActionPayloadHash, readMonadV4Pool, readMonadV4Position,
  readMonadV4TokenAssets, type MonadV3PoolClient,
} from "@tideweave/chain";
import { hashOpaqueValue } from "../auth";
import { monadClient } from "../clients";
import { monShortfallError, walletReserve } from "../delegation";
import type { AppEnvironment, RouteDeps } from "../env";
import { erc20ApproveAbi, jsonBody, record } from "../http";

/** Uniswap v4 on Monad: wallet assets, two-stage approvals, mint, positions and exits. */
export function registerV4Routes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  const { now } = deps;
  app.post("/v1/wallets/v4/approvals/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if (typeof body.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.poolId) ||
        typeof body.tokenAddress !== "string" || !isAddress(body.tokenAddress) ||
        (body.stage !== "erc20" && body.stage !== "permit2") ||
        typeof body.amount !== "string" || !/^[1-9][0-9]*$/.test(body.amount) ||
        (body.stage === "permit2" && (typeof body.expiration !== "string" ||
          !/^[1-9][0-9]*$/.test(body.expiration))) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) {
      return context.json({ error: "INVALID_V4_APPROVAL_REQUEST" }, 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    const row = await context.env.DB.prepare(
      "SELECT currency0, currency1, fee, tick_spacing, hooks FROM monad_v4_pool_directory WHERE pool_id = ?1",
    ).bind(body.poolId).first<{ currency0: Address; currency1: Address;
      fee: number; tick_spacing: number; hooks: Address }>();
    if (!row) return context.json({ error: "POOL_NOT_INDEXED" }, 404);
    const client = monadClient(deps, context.env) as MonadV3PoolClient & {
      getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
      getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      call(input: { account: Address; to: Address; data: Hex; value: bigint;
        blockNumber: bigint }): Promise<{ data?: Hex }>;
      estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint;
        blockNumber: bigint }): Promise<bigint>;
    };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) {
      return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
    }
    let pool;
    let token;
    let approval;
    try {
      pool = await readMonadV4Pool({ client, key: { currency0: getAddress(row.currency0),
        currency1: getAddress(row.currency1), fee: row.fee,
        tickSpacing: row.tick_spacing, hooks: getAddress(row.hooks) },
      blockNumber: safe.number });
      if (pool.id.toLowerCase() !== body.poolId.toLowerCase()) throw new Error("POOL_ID_MISMATCH");
      const requestedTokenAddress = getAddress(body.tokenAddress as string);
      token = [pool.token0, pool.token1].find((candidate) =>
        candidate.address.toLowerCase() === requestedTokenAddress.toLowerCase());
      if (!token) return context.json({ error: "TOKEN_NOT_IN_POOL" }, 422);
      const expiration = body.stage === "permit2" ? BigInt(body.expiration as string) : undefined;
      const seconds = BigInt(Math.floor(now() / 1_000));
      if (expiration !== undefined && (expiration <= seconds ||
          expiration > seconds + 3n * 24n * 60n * 60n)) {
        return context.json({ error: "INVALID_PERMIT2_EXPIRATION" }, 400);
      }
      approval = buildMonadV4Approval({ pool, token: token.address,
        stage: body.stage, amount: BigInt(body.amount), expiration });
    } catch {
      return context.json({ error: "V4_APPROVAL_POOL_OR_AMOUNT_INVALID" }, 422);
    }
    let gasEstimate;
    try {
      const assets = await readMonadV4TokenAssets({ client, owner: wallet.address,
        token: token.address, blockNumber: safe.number });
      if (assets.balance < approval.amount) {
        return context.json({ error: "INSUFFICIENT_TOKEN_BALANCE" }, 422);
      }
      if (approval.stage === "permit2" && assets.erc20Allowance < approval.amount) {
        return context.json({ error: "ERC20_APPROVAL_REQUIRED" }, 422);
      }
      const call = { account: wallet.address, to: approval.to, data: approval.data,
        value: 0n, blockNumber: safe.number };
      const [simulation, estimate, monBalance, fees] = await Promise.all([
        client.call(call), client.estimateGas(call),
        client.getBalance({ address: wallet.address, blockNumber: safe.number }),
        client.estimateFeesPerGas(),
      ]);
      if (approval.stage === "erc20" &&
          (!simulation.data || decodeFunctionResult({ abi: erc20ApproveAbi,
            functionName: "approve", data: simulation.data }) !== true)) {
        return context.json({ error: "TOKEN_APPROVAL_UNSUPPORTED" }, 422);
      }
      if (estimate <= 0n) throw new Error("INVALID_GAS_ESTIMATE");
      const reserve = (estimate * 120n * fees.maxFeePerGas + 99n) / 100n;
      const kept = await walletReserve(client, wallet.address, safe.number);
      if (monBalance < reserve + kept) return context.json({ error: monShortfallError(kept) }, 422);
      gasEstimate = estimate;
    } catch {
      return context.json({ error: "V4_APPROVAL_SIMULATION_FAILED" }, 422);
    }
    const keyHash = await hashOpaqueValue(context.get("agentRun") ? `${context.get("agentRun")!.id}:${body.idempotencyKey}` : body.idempotencyKey);
    const payloadHash = monadV4ApprovalPayloadHash(approval);
    const existing = await context.env.DB.prepare(
      `SELECT id, status, payload_hash FROM wallet_intents
       WHERE wallet_id = ?1 AND kind = 'monad_v4_approval' AND idempotency_key_hash = ?2`,
    ).bind(wallet.id, keyHash).first<{ id: string; status: string; payload_hash: string }>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        return context.json({ error: "IDEMPOTENCY_KEY_REUSED" }, 409);
      }
      return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    }
    const timestamp = now();
    const intentId = `monad_v4_approval_${crypto.randomUUID()}`;
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
          created_at, updated_at, idempotency_key_hash, automation_run_id)
         VALUES (?1, ?2, 'monad_v4_approval', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
      ).bind(intentId, wallet.id, payloadHash, timestamp + 10 * 60_000, timestamp, keyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO monad_v4_approval_intents (intent_id, pool_id, currency0, currency1,
          fee, tick_spacing, hooks, token, token_decimals, stage, amount, expiration,
          target, calldata, simulation_block, simulation_block_hash, gas_estimate, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18)`,
      ).bind(intentId, pool.id, pool.currency0, pool.currency1,
        pool.fee, pool.tickSpacing, pool.hooks, token.address, token.decimals,
        approval.stage, approval.amount.toString(), approval.expiration.toString(),
        approval.to, approval.data, Number(safe.number), safe.hash,
        gasEstimate.toString(), timestamp),
    ]);
    return context.json({ intentId, status: "pending", transaction: {
      chainId: approval.chainId, to: approval.to, data: approval.data, value: "0" },
      simulation: { gasEstimate: gasEstimate.toString(), blockHash: safe.hash } }, 201);
  });
  app.post("/v1/wallets/v4/positions/mint/prepare", async (context) => {
    const body = record(await jsonBody(context));
    const positive = (value: unknown): value is string =>
      typeof value === "string" && /^[1-9][0-9]*$/.test(value);
    if (typeof body.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.poolId) ||
        !positive(body.amount0Desired) || !positive(body.amount1Desired) ||
        typeof body.tickLower !== "number" || typeof body.tickUpper !== "number" ||
        typeof body.slippageBps !== "number" || !positive(body.deadline) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) {
      return context.json({ error: "INVALID_V4_MINT_REQUEST" }, 400);
    }
    const deadline = BigInt(body.deadline);
    const seconds = BigInt(Math.floor(now() / 1_000));
    if (deadline < seconds + 60n || deadline > seconds + 1_800n) {
      return context.json({ error: "INVALID_MINT_DEADLINE" }, 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    const row = await context.env.DB.prepare(
      "SELECT currency0, currency1, fee, tick_spacing, hooks FROM monad_v4_pool_directory WHERE pool_id = ?1",
    ).bind(body.poolId).first<{ currency0: Address; currency1: Address;
      fee: number; tick_spacing: number; hooks: Address }>();
    if (!row) return context.json({ error: "POOL_NOT_INDEXED" }, 404);
    const client = monadClient(deps, context.env) as MonadV3PoolClient & {
      getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
      getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      call(input: { account: Address; to: Address; data: Hex; value: bigint;
        blockNumber: bigint }): Promise<{ data?: Hex }>;
      estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint;
        blockNumber: bigint }): Promise<bigint>;
    };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) {
      return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
    }
    const blockNumber = safe.number;
    let pool;
    let mint;
    try {
      pool = await readMonadV4Pool({ client, key: { currency0: getAddress(row.currency0),
        currency1: getAddress(row.currency1), fee: row.fee,
        tickSpacing: row.tick_spacing, hooks: getAddress(row.hooks) },
      blockNumber: safe.number });
      if (pool.id.toLowerCase() !== body.poolId.toLowerCase()) throw new Error("POOL_ID_MISMATCH");
      mint = buildMonadV4Mint({ pool, recipient: wallet.address,
        tickLower: body.tickLower, tickUpper: body.tickUpper,
        amount0Desired: BigInt(body.amount0Desired),
        amount1Desired: BigInt(body.amount1Desired),
        slippageBps: body.slippageBps, deadline });
    } catch {
      return context.json({ error: "V4_POOL_OR_MINT_LIMITS_INVALID" }, 422);
    }
    let gasEstimate;
    try {
      // Native MON is sent as the mint's value; only ERC-20 sides need balances and approvals.
      const erc20s = [{ token: pool.token0, needed: mint.amount0Max }, { token: pool.token1, needed: mint.amount1Max }]
        .filter(({ token }) => token.address !== zeroAddress);
      const assets = await Promise.all(erc20s.map(async ({ token, needed }) => ({ needed,
        ...(await readMonadV4TokenAssets({ client, owner: wallet.address, token: token.address, blockNumber })) })));
      if (assets.some((asset) => asset.balance < asset.needed)) {
        return context.json({ error: "INSUFFICIENT_TOKEN_BALANCE" }, 422);
      }
      if (assets.some((asset) => asset.erc20Allowance < asset.needed)) {
        return context.json({ error: "ERC20_APPROVAL_REQUIRED" }, 422);
      }
      if (assets.some((asset) => asset.permit2Allowance < asset.needed || asset.permit2Expiration <= deadline)) {
        return context.json({ error: "PERMIT2_APPROVAL_REQUIRED" }, 422);
      }
      const call = { account: wallet.address, to: mint.to,
        data: mint.data, value: mint.value, blockNumber: safe.number };
      const [, estimate, monBalance, fees] = await Promise.all([
        client.call(call), client.estimateGas(call),
        client.getBalance({ address: wallet.address, blockNumber: safe.number }),
        client.estimateFeesPerGas(),
      ]);
      if (estimate <= 0n) throw new Error("INVALID_GAS_ESTIMATE");
      const reserve = (estimate * 120n * fees.maxFeePerGas + 99n) / 100n;
      const kept = await walletReserve(client, wallet.address, safe.number);
      if (monBalance < mint.value + reserve + kept) {
        return context.json({ error: kept > 0n ? monShortfallError(kept)
          : mint.value > 0n ? "INSUFFICIENT_MON" : "INSUFFICIENT_MON_FOR_GAS" }, 422);
      }
      gasEstimate = estimate;
    } catch {
      return context.json({ error: "V4_MINT_SIMULATION_FAILED" }, 422);
    }
    const keyHash = await hashOpaqueValue(context.get("agentRun") ? `${context.get("agentRun")!.id}:${body.idempotencyKey}` : body.idempotencyKey);
    const payloadHash = monadV4MintPayloadHash(mint);
    const existing = await context.env.DB.prepare(
      `SELECT id, status, payload_hash FROM wallet_intents
       WHERE wallet_id = ?1 AND kind = 'monad_v4_mint' AND idempotency_key_hash = ?2`,
    ).bind(wallet.id, keyHash).first<{ id: string; status: string; payload_hash: string }>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        return context.json({ error: "IDEMPOTENCY_KEY_REUSED" }, 409);
      }
      return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    }
    const timestamp = now();
    const intentId = `monad_v4_mint_${crypto.randomUUID()}`;
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
          created_at, updated_at, idempotency_key_hash, automation_run_id)
         VALUES (?1, ?2, 'monad_v4_mint', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
      ).bind(intentId, wallet.id, payloadHash, Number(deadline) * 1_000, timestamp, keyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO monad_v4_mint_intents (intent_id, pool_id, currency0, currency1,
          fee, tick_spacing, hooks, token0_decimals, token1_decimals,
          sqrt_price_x96, tick, liquidity, lp_fee, recipient,
          tick_lower, tick_upper, amount0_desired, amount1_desired, amount0_max,
          amount1_max, slippage_bps, deadline, calldata, simulation_block,
          simulation_block_hash, gas_estimate, created_at, value)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28)`,
      ).bind(intentId, pool.id, pool.currency0, pool.currency1, pool.fee,
        pool.tickSpacing, pool.hooks, pool.token0.decimals, pool.token1.decimals,
        pool.sqrtPriceX96.toString(), pool.tick, pool.liquidity.toString(), pool.lpFee,
        mint.recipient, mint.tickLower, mint.tickUpper,
        body.amount0Desired, body.amount1Desired,
        mint.amount0Max.toString(), mint.amount1Max.toString(),
        body.slippageBps, deadline.toString(), mint.data, Number(safe.number),
        safe.hash, gasEstimate.toString(), timestamp, mint.value.toString()),
    ]);
    return context.json({ intentId, status: "pending", transaction: {
      chainId: mint.chainId, to: mint.to, data: mint.data, value: mint.value.toString() },
      simulation: { amount0: mint.amount0Expected.toString(),
        amount1: mint.amount1Expected.toString(),
        amount0Max: mint.amount0Max.toString(), amount1Max: mint.amount1Max.toString(),
        gasEstimate: gasEstimate.toString(), blockHash: safe.hash } }, 201);
  });
  app.post("/v1/wallets/v4/monad/positions/actions/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if ((body.action !== "collect" && body.action !== "decrease" && body.action !== "withdraw") ||
        (body.action === "decrease" && (typeof body.removeBps !== "number" || !Number.isInteger(body.removeBps) ||
          body.removeBps < 1 || body.removeBps > 9_999)) ||
        typeof body.tokenId !== "string" || !/^[1-9][0-9]*$/.test(body.tokenId) ||
        typeof body.slippageBps !== "number" || !Number.isInteger(body.slippageBps) ||
        body.slippageBps < 0 || body.slippageBps > 500 ||
        typeof body.deadline !== "string" || !/^[1-9][0-9]*$/.test(body.deadline) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) {
      return context.json({ error: "INVALID_V4_ACTION_REQUEST" }, 400);
    }
    const deadline = BigInt(body.deadline);
    const seconds = BigInt(Math.floor(now() / 1_000));
    if (deadline < seconds + 60n || deadline > seconds + 1_800n) {
      return context.json({ error: "INVALID_ACTION_DEADLINE" }, 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active" && wallet.state !== "paused") {
      return context.json({ error: "WALLET_NOT_SIGNABLE" }, 409);
    }
    const client = monadClient(deps, context.env) as MonadV3PoolClient & {
      getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
      getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      call(input: { account: Address; to: Address; data: Hex; value: bigint;
        blockNumber: bigint }): Promise<unknown>;
      estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint;
        blockNumber: bigint }): Promise<bigint>;
    };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) {
      return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
    }
    let position;
    let action;
    try {
      position = await readMonadV4Position({ client, owner: wallet.address,
        tokenId: BigInt(body.tokenId), blockNumber: safe.number });
      action = buildMonadV4PositionAction({ kind: body.action, position,
        removeBps: body.action === "decrease" ? body.removeBps as number : undefined,
        recipient: wallet.address, slippageBps: body.slippageBps, deadline });
    } catch {
      return context.json({ error: "V4_POSITION_NOT_AVAILABLE" }, 422);
    }
    let gasEstimate;
    try {
      const call = { account: wallet.address, to: action.to, data: action.data,
        value: 0n, blockNumber: safe.number };
      const [, estimate, monBalance, fees] = await Promise.all([
        client.call(call), client.estimateGas(call),
        client.getBalance({ address: wallet.address, blockNumber: safe.number }),
        client.estimateFeesPerGas(),
      ]);
      if (estimate <= 0n) throw new Error("INVALID_GAS_ESTIMATE");
      const reserve = (estimate * 120n * fees.maxFeePerGas + 99n) / 100n;
      const kept = await walletReserve(client, wallet.address, safe.number);
      if (monBalance < reserve + kept) return context.json({ error: monShortfallError(kept) }, 422);
      gasEstimate = estimate;
    } catch {
      return context.json({ error: "V4_ACTION_SIMULATION_FAILED" }, 422);
    }
    const kind = `monad_v4_position_${action.kind}`;
    const keyHash = await hashOpaqueValue(context.get("agentRun") ? `${context.get("agentRun")!.id}:${body.idempotencyKey}` : body.idempotencyKey);
    const payloadHash = monadV4PositionActionPayloadHash(action);
    const existing = await context.env.DB.prepare(
      "SELECT id, status, payload_hash FROM wallet_intents WHERE wallet_id = ?1 AND kind = ?2 AND idempotency_key_hash = ?3",
    ).bind(wallet.id, kind, keyHash).first<{ id: string; status: string; payload_hash: string }>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        return context.json({ error: "IDEMPOTENCY_KEY_REUSED" }, 409);
      }
      return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    }
    const timestamp = now();
    const intentId = `monad_v4_action_${crypto.randomUUID()}`;
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status,
          expires_at, created_at, updated_at, idempotency_key_hash, automation_run_id)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6, ?7, ?8)`,
      ).bind(intentId, wallet.id, kind, payloadHash, Number(deadline) * 1_000,
        timestamp, keyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO monad_v4_position_action_intents (intent_id, action, pool_id,
          token_id, tick_lower, tick_upper, liquidity, slippage_bps, deadline,
          recipient, calldata, simulation_block, simulation_block_hash, gas_estimate,
          sqrt_price_x96, tick, pool_liquidity, lp_fee, created_at, remove_bps)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19, ?20)`,
      ).bind(intentId, action.kind, action.poolId, action.tokenId.toString(),
        position.tickLower, position.tickUpper, position.liquidity.toString(),
        body.slippageBps, deadline.toString(), action.recipient, action.data,
        Number(safe.number), safe.hash, gasEstimate.toString(),
        position.pool.sqrtPriceX96.toString(), position.pool.tick,
        position.pool.liquidity.toString(), position.pool.lpFee, timestamp, action.removeBps),
    ]);
    return context.json({ intentId, status: "pending", ...(body.action === "withdraw" ? (() => { const amounts = withdrawalMinimums("uniswap-v4", action.data); return { minimum0: amounts.amount0.toString(), minimum1: amounts.amount1.toString() }; })() : {}), transaction: {
      chainId: action.chainId, to: action.to, data: action.data, value: "0" },
      simulation: { gasEstimate: gasEstimate.toString(), blockHash: safe.hash } }, 201);
  });
}
