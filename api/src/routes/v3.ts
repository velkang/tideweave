import type { Hono } from "hono";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  withdrawalMinimums,  UNISWAP_V3_MONAD, approvalPayloadHash, buildMonadV3Approval, buildMonadV3CollectAll,
  buildMonadV3DecreaseLiquidity, buildMonadV3FullWithdrawal, buildMonadV3Mint, mintPayloadHash,
  positionActionPayloadHash, readMonadV3Pool, readMonadV3Position, simulateApproval, simulateMint,
  simulatePositionAction, type ApprovalSimulationClient, type MonadV3PoolClient,
  type PositionActionClient,
} from "@tideweave/chain";
import { hashOpaqueValue } from "../auth";
import { monadClient } from "../clients";
import { monShortfallError, walletReserve } from "../delegation";
import type { AppEnvironment, RouteDeps } from "../env";
import { erc20Abi, jsonBody, record } from "../http";

/** Uniswap v3 on Monad: wallet assets, approvals, mint, positions and exits. */
export function registerV3Routes(app: Hono<AppEnvironment>, deps: RouteDeps) {
  const { now } = deps;
  app.post("/v1/wallets/v3/approvals/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if (typeof body.poolAddress !== "string" || !isAddress(body.poolAddress) ||
        typeof body.tokenAddress !== "string" || !isAddress(body.tokenAddress) ||
        typeof body.amount !== "string" || !/^[1-9][0-9]*$/.test(body.amount) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) {
      return context.json({ error: "INVALID_APPROVAL_REQUEST" }, 400);
    }
    const requestedPoolAddress = getAddress(body.poolAddress);
    const requestedTokenAddress = getAddress(body.tokenAddress);
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    const client = monadClient(deps, context.env) as MonadV3PoolClient & ApprovalSimulationClient & {
      getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
    };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) {
      return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
    }
    let pool;
    try {
      pool = await readMonadV3Pool({ client, poolAddress: requestedPoolAddress,
        blockNumber: safe.number });
    } catch {
      return context.json({ error: "POOL_NOT_AVAILABLE" }, 422);
    }
    const token = [pool.token0, pool.token1].find((candidate) =>
      candidate.address.toLowerCase() === requestedTokenAddress.toLowerCase());
    if (!token) return context.json({ error: "TOKEN_NOT_IN_POOL" }, 422);
    let approval;
    try {
      approval = buildMonadV3Approval({ tokenAddress: token.address, tokenSymbol: token.symbol,
        amount: BigInt(body.amount) });
    } catch {
      return context.json({ error: "INVALID_APPROVAL_AMOUNT" }, 400);
    }
    let simulation;
    try {
      simulation = await simulateApproval({ client, owner: wallet.address, approval,
        blockNumber: safe.number });
      const [balance, fees] = await Promise.all([
        client.getBalance({ address: wallet.address, blockNumber: safe.number }),
        client.estimateFeesPerGas(),
      ]);
      const reserve = (BigInt(simulation.gasEstimate) * 120n * fees.maxFeePerGas + 99n) / 100n;
      const kept = await walletReserve(client, wallet.address, safe.number);
      if (balance < reserve + kept) return context.json({ error: monShortfallError(kept) }, 422);
    } catch {
      return context.json({ error: "APPROVAL_SIMULATION_FAILED" }, 422);
    }
    const keyHash = await hashOpaqueValue(context.get("agentRun") ? `${context.get("agentRun")!.id}:${body.idempotencyKey}` : body.idempotencyKey);
    const payloadHash = approvalPayloadHash(approval);
    const existing = await context.env.DB.prepare(
      `SELECT id, status, payload_hash FROM wallet_intents
       WHERE wallet_id = ?1 AND kind = 'monad_v3_approval' AND idempotency_key_hash = ?2`,
    ).bind(wallet.id, keyHash).first<{ id: string; status: string; payload_hash: string }>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        return context.json({ error: "IDEMPOTENCY_KEY_REUSED" }, 409);
      }
      return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    }
    const timestamp = now();
    const intentId = `monad_v3_approval_${crypto.randomUUID()}`;
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
          created_at, updated_at, idempotency_key_hash, automation_run_id)
         VALUES (?1, ?2, 'monad_v3_approval', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
      ).bind(intentId, wallet.id, payloadHash, timestamp + 10 * 60_000, timestamp, keyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO approval_intents (intent_id, chain_id, token_symbol, token_address,
          token_decimals, pool_address, pool_token_address, spender, amount, calldata,
          simulation_block, simulation_block_hash, gas_estimate, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      ).bind(intentId, approval.chainId, token.symbol, token.address, token.decimals,
        pool.id, token.address, approval.spender, approval.amount.toString(), approval.data,
        Number(safe.number), safe.hash, simulation.gasEstimate, timestamp),
    ]);
    return context.json({ intentId, status: "pending", transaction: {
      chainId: approval.chainId, to: approval.to, data: approval.data, value: "0" },
      simulation: { ...simulation, blockHash: safe.hash } }, 201);
  });
  app.post("/v1/wallets/v3/positions/mint/prepare", async (context) => {
    const body = record(await jsonBody(context));
    const positive = (value: unknown): value is string =>
      typeof value === "string" && /^[1-9][0-9]*$/.test(value);
    if (typeof body.poolAddress !== "string" || !isAddress(body.poolAddress) ||
        !positive(body.amount0Desired) || !positive(body.amount1Desired) ||
        typeof body.tickLower !== "number" || typeof body.tickUpper !== "number" ||
        typeof body.slippageBps !== "number" || !positive(body.deadline) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) {
      return context.json({ error: "INVALID_MINT_REQUEST" }, 400);
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
    const client = monadClient(deps, context.env) as MonadV3PoolClient & ApprovalSimulationClient & {
      getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
    };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) {
      return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
    }
    const blockNumber = safe.number;
    let pool;
    try {
      pool = await readMonadV3Pool({ client, poolAddress: getAddress(body.poolAddress),
        blockNumber });
    } catch {
      return context.json({ error: "POOL_NOT_AVAILABLE" }, 422);
    }
    const amount0Desired = BigInt(body.amount0Desired);
    const amount1Desired = BigInt(body.amount1Desired);
    const balances = await Promise.all([pool.token0, pool.token1].map(async (token) => {
      const [balance, allowance] = await Promise.all([
        client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf",
          args: [wallet.address], blockNumber }),
        client.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance",
          args: [wallet.address, UNISWAP_V3_MONAD.nonfungiblePositionManager],
          blockNumber }),
      ]);
      return { balance, allowance };
    }));
    const [balance0, balance1] = balances.map((item) => item.balance);
    const [allowance0, allowance1] = balances.map((item) => item.allowance);
    if (typeof balance0 !== "bigint" || typeof balance1 !== "bigint" ||
        typeof allowance0 !== "bigint" || typeof allowance1 !== "bigint") {
      return context.json({ error: "TOKEN_READ_FAILED" }, 502);
    }
    if (balance0 < amount0Desired || balance1 < amount1Desired) {
      return context.json({ error: "INSUFFICIENT_TOKEN_BALANCE" }, 422);
    }
    if (allowance0 < amount0Desired || allowance1 < amount1Desired) {
      return context.json({ error: "TOKEN_APPROVAL_REQUIRED" }, 422);
    }
    let mint;
    let simulation;
    try {
      const common = { pool, recipient: wallet.address, tickLower: body.tickLower,
        tickUpper: body.tickUpper, amount0Desired, amount1Desired,
        slippageBps: body.slippageBps, deadline };
      const probe = buildMonadV3Mint({ ...common, amount0Min: 0n, amount1Min: 0n });
      const quoted = await simulateMint({ client, owner: wallet.address, mint: probe,
        blockNumber });
      const consumed0 = BigInt(quoted.amount0);
      const consumed1 = BigInt(quoted.amount1);
      if (consumed0 <= 0n || consumed1 <= 0n) {
        return context.json({ error: "BOTH_TOKENS_REQUIRED" }, 422);
      }
      const factor = 10_000n - BigInt(body.slippageBps);
      mint = buildMonadV3Mint({ ...common,
        amount0Min: consumed0 * factor / 10_000n,
        amount1Min: consumed1 * factor / 10_000n });
      simulation = await simulateMint({ client, owner: wallet.address, mint,
        blockNumber });
      const [balance, fees] = await Promise.all([
        client.getBalance({ address: wallet.address, blockNumber }),
        client.estimateFeesPerGas(),
      ]);
      const reserve = (BigInt(simulation.gasEstimate) * 120n * fees.maxFeePerGas + 99n) / 100n;
      const kept = await walletReserve(client, wallet.address, blockNumber);
      if (balance < reserve + kept) return context.json({ error: monShortfallError(kept) }, 422);
    } catch {
      return context.json({ error: "MINT_SIMULATION_FAILED" }, 422);
    }
    const keyHash = await hashOpaqueValue(context.get("agentRun") ? `${context.get("agentRun")!.id}:${body.idempotencyKey}` : body.idempotencyKey);
    const payloadHash = mintPayloadHash(mint);
    const existing = await context.env.DB.prepare(
      `SELECT id, status, payload_hash FROM wallet_intents
       WHERE wallet_id = ?1 AND kind = 'monad_v3_mint' AND idempotency_key_hash = ?2`,
    ).bind(wallet.id, keyHash).first<{ id: string; status: string; payload_hash: string }>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        return context.json({ error: "IDEMPOTENCY_KEY_REUSED" }, 409);
      }
      return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    }
    const timestamp = now();
    const intentId = `monad_v3_mint_${crypto.randomUUID()}`;
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
          created_at, updated_at, idempotency_key_hash, automation_run_id)
         VALUES (?1, ?2, 'monad_v3_mint', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
      ).bind(intentId, wallet.id, payloadHash, Number(deadline) * 1_000, timestamp, keyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO mint_intents (intent_id, chain_id, position_manager, recipient,
          tick_lower, tick_upper, amount0_desired, amount1_desired, amount0_min, amount1_min,
          slippage_bps, deadline, calldata, simulation_block, simulation_block_hash,
          gas_estimate, simulated_token_id, simulated_liquidity, simulated_amount0,
          simulated_amount1, created_at, pool_address, token0_address, token1_address,
          fee, tick_spacing)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)`,
      ).bind(intentId, mint.chainId, mint.to, mint.recipient, mint.tickLower, mint.tickUpper,
        mint.amount0Desired.toString(), mint.amount1Desired.toString(),
        mint.amount0Min.toString(), mint.amount1Min.toString(), mint.slippageBps,
        mint.deadline.toString(), mint.data, Number(safe.number), safe.hash,
        simulation.gasEstimate, simulation.tokenId, simulation.liquidity,
        simulation.amount0, simulation.amount1, timestamp, pool.id,
        pool.token0.address, pool.token1.address, pool.fee, pool.tickSpacing),
    ]);
    return context.json({ intentId, status: "pending", transaction: {
      chainId: mint.chainId, to: mint.to, data: mint.data, value: "0" },
      pool: { ...pool, sqrtPriceX96: pool.sqrtPriceX96.toString(),
        liquidity: pool.liquidity.toString() },
      simulation: { ...simulation, blockHash: safe.hash } }, 201);
  });
  app.post("/v1/wallets/v3/positions/actions/prepare", async (context) => {
    const body = record(await jsonBody(context));
    const actionKind = body.action;
    if (actionKind !== "collect" && actionKind !== "decrease" && actionKind !== "withdraw") {
      return context.json({ error: "INVALID_POSITION_ACTION" }, 400);
    }
    if (typeof body.tokenId !== "string" || !/^[1-9][0-9]*$/.test(body.tokenId) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200 ||
        (actionKind === "decrease" && (typeof body.liquidity !== "string" ||
          !/^[1-9][0-9]*$/.test(body.liquidity))) ||
        (actionKind !== "collect" && (typeof body.slippageBps !== "number" ||
          !Number.isInteger(body.slippageBps) || body.slippageBps < 0 || body.slippageBps > 500 ||
          typeof body.deadline !== "string" || !/^[1-9][0-9]*$/.test(body.deadline)))) {
      return context.json({ error: "INVALID_POSITION_ACTION" }, 400);
    }
    const deadline = actionKind === "collect" ? 0n : BigInt(body.deadline as string);
    const seconds = BigInt(Math.floor(now() / 1_000));
    if (actionKind !== "collect" && (deadline < seconds + 60n || deadline > seconds + 1_800n)) {
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
    const client = monadClient(deps, context.env) as MonadV3PoolClient & PositionActionClient & {
      getBlock(input: { blockTag: "safe" }): Promise<{ number: bigint | null; hash: Hex | null }>;
      getBalance(input: { address: Address; blockNumber?: bigint }): Promise<bigint>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
    };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) {
      return context.json({ error: "SAFE_BLOCK_UNAVAILABLE" }, 503);
    }
    const blockNumber = safe.number;
    let position;
    try {
      position = await readMonadV3Position({ client, owner: wallet.address,
        tokenId: BigInt(body.tokenId), blockNumber });
    } catch {
      return context.json({ error: "POSITION_NOT_AVAILABLE" }, 422);
    }
    const liquidity = actionKind === "decrease" ? BigInt(body.liquidity as string) : position.liquidity;
    if (actionKind !== "collect" && (liquidity <= 0n || liquidity > position.liquidity)) {
      return context.json({ error: "INVALID_POSITION_LIQUIDITY" }, 422);
    }
    let action;
    let simulation;
    let expected0: bigint | undefined;
    let expected1: bigint | undefined;
    try {
      if (actionKind === "collect") {
        action = buildMonadV3CollectAll({ tokenId: position.tokenId, recipient: wallet.address });
      } else {
        const common = { tokenId: position.tokenId, recipient: wallet.address,
          liquidity, deadline, slippageBps: body.slippageBps as number };
        const probe = actionKind === "withdraw"
          ? buildMonadV3FullWithdrawal({ ...common, expected0: 1n, expected1: 0n,
            slippageBps: 500 })
          : buildMonadV3DecreaseLiquidity({ ...common, expected0: 1n, expected1: 0n,
            slippageBps: 500 });
        const quoted = await simulatePositionAction({ client, owner: wallet.address, action: probe,
          blockNumber });
        const output = quoted.output as Record<string, string>;
        expected0 = BigInt(output[actionKind === "withdraw" ? "decreased0" : "amount0"]);
        expected1 = BigInt(output[actionKind === "withdraw" ? "decreased1" : "amount1"]);
        if (expected0 + expected1 <= 0n) {
          return context.json({ error: "POSITION_HAS_NO_WITHDRAWABLE_ASSETS" }, 422);
        }
        action = actionKind === "withdraw"
          ? buildMonadV3FullWithdrawal({ ...common, expected0, expected1 })
          : buildMonadV3DecreaseLiquidity({ ...common, expected0, expected1 });
      }
      simulation = await simulatePositionAction({ client, owner: wallet.address, action,
        blockNumber });
      const [balance, fees] = await Promise.all([
        client.getBalance({ address: wallet.address, blockNumber }),
        client.estimateFeesPerGas(),
      ]);
      const reserve = (BigInt(simulation.gasEstimate) * 120n * fees.maxFeePerGas + 99n) / 100n;
      const kept = await walletReserve(client, wallet.address, blockNumber);
      if (balance < reserve + kept) return context.json({ error: monShortfallError(kept) }, 422);
    } catch {
      return context.json({ error: "POSITION_ACTION_SIMULATION_FAILED" }, 422);
    }
    const keyHash = await hashOpaqueValue(context.get("agentRun") ? `${context.get("agentRun")!.id}:${body.idempotencyKey}` : body.idempotencyKey);
    const payloadHash = positionActionPayloadHash(action);
    const kind = `monad_v3_position_${actionKind}`;
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
    const intentId = `monad_v3_action_${crypto.randomUUID()}`;
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status,
          expires_at, created_at, updated_at, idempotency_key_hash, automation_run_id)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6, ?7, ?8)`,
      ).bind(intentId, wallet.id, kind, payloadHash,
        actionKind === "collect" ? timestamp + 10 * 60_000 : Number(deadline) * 1_000,
        timestamp, keyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO position_action_intents (intent_id, action, chain_id,
          position_manager, token_id, recipient, calldata, constraints_json,
          simulation_block, simulation_block_hash, gas_estimate, simulation_output_json,
          created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(intentId, action.kind, action.chainId, action.to, action.tokenId.toString(),
        action.recipient, action.data, JSON.stringify({ poolAddress: position.pool.id,
          expected0: expected0?.toString(), expected1: expected1?.toString() }),
        Number(blockNumber), safe.hash, simulation.gasEstimate,
        JSON.stringify(simulation.output), timestamp),
    ]);
    return context.json({ intentId, status: "pending", ...(body.action === "withdraw" ? (() => { const amounts = withdrawalMinimums("uniswap-v3", action.data); return { minimum0: amounts.amount0.toString(), minimum1: amounts.amount1.toString() }; })() : {}), transaction: {
      chainId: action.chainId, to: action.to, data: action.data, value: "0" },
      simulation: { ...simulation, blockHash: safe.hash } }, 201);
  });
}
