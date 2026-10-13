import { monadAutomationReason } from './monad-automation-policy';
import {
  readMonUsd, positionManagerAbi, type ChainReadClient,
  readMonadV3Pool,
  readMonadV3Position,
  type MonadV3Pool,
  type MonadV3PoolClient,
  type MonadV4PoolKey,
  type MonadV4Pool,
  type MonadV4Approval,
  type MonadV4Mint,
  type MonadV4PositionAction,
  UNISWAP_V4_MONAD,
  readMonadV4Pool,
  readMonadV4Position,
  readMonadV4TokenAssets,
  buildMonadV4Approval,
  buildMonadV4Mint,
  buildMonadV4PositionAction,
  erc20TransferAbi,
  type MonadWithdrawal,
} from "@tideweave/chain";
import { parseAbi, decodeFunctionData, type Address, type Hex } from "viem";
import type { MainnetIntentKind } from "./mainnet-policy";
import type { WalletState } from "./policy";
import type { AutomationContext } from "./mandate-policy";
import { isMonadV3IntentKind, validateMonadV3Intent } from "./monad-v3-policy";
import { isMonadV4IntentKind, validateMonadV4Intent } from "./monad-v4-policy";
import { validateMonadWithdrawal } from "./monad-withdrawal-policy";
import type { StoredNadIntent } from "./monad-nadfun-store";
import type { StoredSwap, StoredSwapApproval } from "./monad-swap-store";
import { isSwapIntentKind } from "./monad-swap-policy";
import { evaluateSwapLoaded } from "./monad-swap-evaluator";
import { evaluateWrapLoaded } from "./monad-wrap-evaluator";
import { isWrapIntentKind } from "./monad-wrap-policy";
import type { StoredWrap } from "./monad-wrap-store";
import { isNadIntentKind } from "./monad-nadfun-policy";
import { evaluateNadLoaded } from "./monad-nadfun-evaluator";
import { zeroAddress } from "viem";

export type CustodyWallet = {
  walletId: string;
  dynamicWalletId: string;
  address: Address;
};

export type LoadedMainnetIntent = {
  intentId: string;
  kind: MainnetIntentKind;
  status: string;
  expiresAt: number;
  payloadHash: Hex;
  wallet: { address: Address; state: WalletState };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  approvalPool?: { tokenAddress: Address; poolAddress: Address; poolTokenAddress: Address; tokenDecimals?: number };
  mintPool?: {
    poolAddress: Address;
    token0: Address;
    token1: Address;
    fee: number;
    tickSpacing: number;
    tokenDecimals?: number;
  };
  monadV4Approval?: { poolId: Hex; key: MonadV4PoolKey; token: Address;
    tokenDecimals: number; stage: "erc20" | "permit2"; amount: bigint;
    expiration: bigint };
  monadV4Mint?: { poolId: Hex; key: MonadV4PoolKey;
    token0Decimals: number; token1Decimals: number;
    snapshot: { sqrtPriceX96: bigint; tick: number; liquidity: bigint; lpFee: number };
    recipient: Address; tickLower: number; tickUpper: number;
    amount0Desired: bigint; amount1Desired: bigint;
    amount0Max: bigint; amount1Max: bigint;
    slippageBps: number; deadline: bigint };
  monadV4PositionAction?: { kind: "collect" | "decrease" | "withdraw"; removeBps: number; poolId: Hex;
    tokenId: bigint; tickLower: number; tickUpper: number; liquidity: bigint;
    slippageBps: number; deadline: bigint; recipient: Address;
    snapshot: { sqrtPriceX96: bigint; tick: number; liquidity: bigint; lpFee: number } };
  tokenId?: bigint;
  actionPoolAddress?: Address;
  expected0?: bigint;
  expected1?: bigint;
  monadWithdrawal?: { transaction: MonadWithdrawal };
  monadNadfun?: StoredNadIntent;
  monadSwap?: StoredSwap;
  monadSwapApproval?: StoredSwapApproval;
  monadWrap?: StoredWrap;
  /** The Dynamic wallet that signs for this Tideweave wallet. */
  custody?: CustodyWallet;
  /** Set when the automation agent made this request rather than the user. */
  automation?: AutomationContext;
};

export type MainnetEvaluation = {
  intentId: string;
  decision: "allowed" | "rejected";
  reasonCode: string;
  blockNumber: number | null;
  createdAt: number;
};

export interface MainnetEvaluationStore {
  load(intentId: string): Promise<LoadedMainnetIntent | null>;
  save(evaluation: MainnetEvaluation): Promise<void>;
}

export type MainnetAuditClient = ChainReadClient & {
  getBlock(parameters: { blockTag: "safe" }): Promise<{
    number: bigint | null;
    hash: Hex | null;
  }>;
  call(parameters: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    blockNumber?: bigint;
    stateOverride?: Array<{ address: Address; code: Hex }>;
  }): Promise<unknown>;
  getCode?(parameters: { address: Address; blockNumber?: bigint }): Promise<`0x${string}` | undefined>;
};

export class MainnetEvaluationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function evaluateMainnetIntent(input: {
  intentId: string;
  store: MainnetEvaluationStore;
  client: MainnetAuditClient;
  emergencyStop: boolean;
  now?: () => number;
}): Promise<MainnetEvaluation> {
  const loaded = await input.store.load(input.intentId);
  if (!loaded) throw new MainnetEvaluationError("MAINNET_INTENT_NOT_FOUND", 404);
  return evaluateLoadedMainnetIntent({ ...input, loaded });
}

export async function evaluateLoadedMainnetIntent(input: {
  loaded: LoadedMainnetIntent;
  store: Pick<MainnetEvaluationStore, "save">;
  client: MainnetAuditClient;
  emergencyStop: boolean;
  now?: () => number;
}): Promise<MainnetEvaluation> {
  const now = input.now ?? Date.now;
  const loaded = input.loaded;
  if (loaded.transaction.chainId !== 143 ||
      (!isMonadV3IntentKind(loaded.kind) && !isMonadV4IntentKind(loaded.kind) &&
       !isSwapIntentKind(loaded.kind) && !isNadIntentKind(loaded.kind) && !isWrapIntentKind(loaded.kind) &&
       loaded.kind !== "monad_withdrawal")) {
    const result: MainnetEvaluation = { intentId: loaded.intentId, decision: "rejected",
      reasonCode: loaded.transaction.chainId !== 143 ? "CHAIN_NOT_ALLOWED" : "INTENT_KIND_INVALID",
      blockNumber: null, createdAt: now() };
    await input.store.save(result);
    return result;
  }
  const safeBlock = await input.client.getBlock({ blockTag: "safe" });
  if (safeBlock.number === null || safeBlock.hash === null) {
    throw new MainnetEvaluationError("MONAD_SAFE_BLOCK_UNAVAILABLE", 503);
  }

  if (isMonadV3IntentKind(loaded.kind)) {
    const result = await evaluateMonadV3Loaded({ loaded, client: input.client,
      blockNumber: safeBlock.number, emergencyStop: input.emergencyStop, now: now() });
    await input.store.save(result);
    return result;
  }
  if (isMonadV4IntentKind(loaded.kind)) {
    const result = await evaluateMonadV4Loaded({ loaded, client: input.client,
      blockNumber: safeBlock.number, emergencyStop: input.emergencyStop, now: now() });
    await input.store.save(result);
    return result;
  }
  if (isSwapIntentKind(loaded.kind)) {
    const result = await evaluateSwapLoaded({ loaded, client: input.client,
      blockNumber: safeBlock.number, emergencyStop: input.emergencyStop, now: now() });
    await input.store.save(result);
    return result;
  }
  if (isWrapIntentKind(loaded.kind)) {
    const result = await evaluateWrapLoaded({ loaded, client: input.client,
      blockNumber: safeBlock.number, emergencyStop: input.emergencyStop, now: now() });
    await input.store.save(result);
    return result;
  }
  if (isNadIntentKind(loaded.kind)) {
    const result = await evaluateNadLoaded({ loaded, client: input.client,
      blockNumber: safeBlock.number, emergencyStop: input.emergencyStop, now: now() });
    await input.store.save(result);
    return result;
  }
  if (loaded.kind === "monad_withdrawal") {
    const result = await evaluateMonadWithdrawalLoaded({ loaded, client: input.client,
      blockNumber: safeBlock.number, now: now() });
    await input.store.save(result);
    return result;
  }

  const result: MainnetEvaluation = { intentId: loaded.intentId, decision: "rejected",
    reasonCode: "INTENT_KIND_INVALID", blockNumber: Number(safeBlock.number), createdAt: now() };
  await input.store.save(result);
  return result;
}

async function evaluateMonadV3Loaded(input: {
  loaded: LoadedMainnetIntent;
  client: MainnetAuditClient;
  blockNumber: bigint;
  emergencyStop: boolean;
  now: number;
}): Promise<MainnetEvaluation> {
  const { loaded, client, blockNumber, now } = input;
  const finish = (decision: "allowed" | "rejected", reasonCode: string): MainnetEvaluation => ({
    intentId: loaded.intentId, decision, reasonCode, blockNumber: Number(blockNumber), createdAt: now,
  });
  if (!isMonadV3IntentKind(loaded.kind)) return finish("rejected", "INTENT_KIND_INVALID");
  if (!client.getCode) return finish("rejected", "POOL_VERIFICATION_UNAVAILABLE");
  try {
    let pool: MonadV3Pool;
    let position: Parameters<typeof validateMonadV3Intent>[0]["position"];
    let mintExpected: Parameters<typeof validateMonadV3Intent>[0]["mintExpected"];
    if (loaded.kind === "monad_v3_approval") {
      const stored = loaded.approvalPool;
      if (!stored) return finish("rejected", "APPROVAL_POOL_MISSING");
      pool = await readMonadV3Pool({ client: client as MonadV3PoolClient,
        poolAddress: stored.poolAddress, blockNumber });
      const token = [pool.token0, pool.token1].find((item) =>
        item.address.toLowerCase() === stored.tokenAddress.toLowerCase());
      if (!token || (stored.tokenDecimals !== undefined && token.decimals !== stored.tokenDecimals)) {
        return finish("rejected", "APPROVAL_TOKEN_MISMATCH");
      }
    } else if (loaded.kind === "monad_v3_mint") {
      const stored = loaded.mintPool;
      if (!stored) return finish("rejected", "MINT_POOL_MISSING");
      pool = await readMonadV3Pool({ client: client as MonadV3PoolClient,
        poolAddress: stored.poolAddress, blockNumber });
      if (pool.token0.address.toLowerCase() !== stored.token0.toLowerCase() ||
          pool.token1.address.toLowerCase() !== stored.token1.toLowerCase() ||
          pool.fee !== stored.fee || pool.tickSpacing !== stored.tickSpacing) {
        return finish("rejected", "MINT_POOL_MISMATCH");
      }
      const decoded = decodeFunctionData({ abi: positionManagerAbi, data: loaded.transaction.data });
      if (decoded.functionName !== "mint") return finish("rejected", "MINT_CALLDATA_INVALID");
      const quoted = await client.simulateContract({ address: loaded.transaction.to,
        abi: positionManagerAbi, functionName: "mint",
        args: [{ ...decoded.args[0], amount0Min: 0n, amount1Min: 0n }],
        account: loaded.wallet.address, blockNumber });
      if (!Array.isArray(quoted.result) || typeof quoted.result[2] !== "bigint" ||
          typeof quoted.result[3] !== "bigint") return finish("rejected", "MINT_QUOTE_INVALID");
      mintExpected = { amount0: quoted.result[2], amount1: quoted.result[3] };
    } else {
      if (!loaded.tokenId || !loaded.actionPoolAddress) {
        return finish("rejected", "POSITION_CONTEXT_MISSING");
      }
      const current = await readMonadV3Position({ client: client as MonadV3PoolClient,
        owner: loaded.wallet.address, tokenId: loaded.tokenId, blockNumber });
      pool = current.pool;
      if (pool.id.toLowerCase() !== loaded.actionPoolAddress.toLowerCase()) {
        return finish("rejected", "POSITION_POOL_MISMATCH");
      }
      position = { tokenId: loaded.tokenId, owner: loaded.wallet.address,
        liquidity: current.liquidity, expected0: loaded.expected0, expected1: loaded.expected1 };
    }
    await client.call({ account: loaded.wallet.address, to: loaded.transaction.to,
      data: loaded.transaction.data, value: loaded.transaction.value, blockNumber });
    if (loaded.automation) {
      let amounts = { amount0: 0n, amount1: 0n };
      let ticks: { tickLower?: number; tickUpper?: number } = {};
      if (loaded.kind === 'monad_v3_approval') {
        const decoded = decodeFunctionData({ abi: parseAbi(['function approve(address spender,uint256 amount) returns (bool)']), data: loaded.transaction.data });
        if (loaded.approvalPool!.tokenAddress.toLowerCase() === pool.token0.address.toLowerCase()) amounts.amount0 = decoded.args[1];
        else amounts.amount1 = decoded.args[1];
      } else if (loaded.kind === 'monad_v3_mint') {
        const decoded = decodeFunctionData({ abi: positionManagerAbi, data: loaded.transaction.data });
        if (decoded.functionName !== 'mint') return finish('rejected', 'MINT_CALLDATA_INVALID');
        amounts = { amount0: decoded.args[0].amount0Desired, amount1: decoded.args[0].amount1Desired };
        ticks = decoded.args[0];
      }
      const reason = monadAutomationReason(loaded, pool, await readMonUsd(client as MonadV3PoolClient, blockNumber).catch(() => null),
        { ...amounts, ...ticks, tokenId: position?.tokenId });
      if (reason) return finish('rejected', reason);
    }
    const decision = validateMonadV3Intent({ now, emergencyStop: input.emergencyStop,
      wallet: loaded.wallet, intent: { kind: loaded.kind, status: loaded.status,
        expiresAt: loaded.expiresAt, payloadHash: loaded.payloadHash },
      transaction: loaded.transaction, pool, position, mintExpected,
      simulation: { success: true, blockNumber, latestBlockNumber: blockNumber } });
    return finish(decision.allowed ? "allowed" : "rejected", decision.reason);
  } catch (error) {
    console.error("Monad v3 chain revalidation failed for intent:", loaded.intentId, error);
    return finish("rejected", "CHAIN_REVALIDATION_FAILED");
  }
}

async function evaluateMonadV4Loaded(input: {
  loaded: LoadedMainnetIntent;
  client: MainnetAuditClient;
  blockNumber: bigint;
  emergencyStop: boolean;
  now: number;
}): Promise<MainnetEvaluation> {
  const { loaded, client, blockNumber, now } = input;
  const finish = (decision: "allowed" | "rejected", reasonCode: string): MainnetEvaluation => ({
    intentId: loaded.intentId, decision, reasonCode, blockNumber: Number(blockNumber), createdAt: now,
  });
  if (!isMonadV4IntentKind(loaded.kind)) return finish("rejected", "INTENT_KIND_INVALID");
  if (!client.getCode) return finish("rejected", "POOL_VERIFICATION_UNAVAILABLE");
  try {
    let pool: MonadV4Pool;
    let expected: MonadV4Approval | MonadV4Mint | MonadV4PositionAction;
    if (loaded.kind === "monad_v4_approval") {
      const stored = loaded.monadV4Approval;
      if (!stored) return finish("rejected", "APPROVAL_CONTEXT_MISSING");
      pool = await readMonadV4Pool({ client: client as MonadV3PoolClient,
        key: stored.key, blockNumber });
      if (pool.id.toLowerCase() !== stored.poolId.toLowerCase()) {
        return finish("rejected", "APPROVAL_POOL_MISMATCH");
      }
      const token = [pool.token0, pool.token1].find((item) =>
        item.address.toLowerCase() === stored.token.toLowerCase());
      if (!token || token.decimals !== stored.tokenDecimals) {
        return finish("rejected", "APPROVAL_TOKEN_MISMATCH");
      }
      expected = buildMonadV4Approval({ pool, token: token.address,
        stage: stored.stage, amount: stored.amount, expiration: stored.expiration });
      if (stored.stage === "erc20") {
        const result = await client.simulateContract({ address: token.address,
          abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
            inputs: [{ type: "address", name: "spender" },
              { type: "uint256", name: "amount" }],
            outputs: [{ type: "bool" }] }], functionName: "approve",
          args: [UNISWAP_V4_MONAD.permit2, stored.amount],
          account: loaded.wallet.address, blockNumber });
        if (result.result !== true) return finish("rejected", "TOKEN_APPROVAL_UNSUPPORTED");
      }
    } else if (loaded.kind === "monad_v4_mint") {
      const stored = loaded.monadV4Mint;
      if (!stored) return finish("rejected", "MINT_CONTEXT_MISSING");
      pool = await readMonadV4Pool({ client: client as MonadV3PoolClient,
        key: stored.key, blockNumber });
      if (pool.id.toLowerCase() !== stored.poolId.toLowerCase() ||
          pool.token0.decimals !== stored.token0Decimals ||
          pool.token1.decimals !== stored.token1Decimals) {
        return finish("rejected", "MINT_POOL_MISMATCH");
      }
      expected = buildMonadV4Mint({ pool: { ...pool, ...stored.snapshot },
        recipient: stored.recipient, tickLower: stored.tickLower,
        tickUpper: stored.tickUpper, amount0Desired: stored.amount0Desired,
        amount1Desired: stored.amount1Desired,
        slippageBps: stored.slippageBps, deadline: stored.deadline });
      if (expected.amount0Max !== stored.amount0Max ||
          expected.amount1Max !== stored.amount1Max) {
        return finish("rejected", "MINT_BUDGET_MISMATCH");
      }
      const mint = expected;
      // Native MON is sent as value: it needs a balance but no ERC-20 or Permit2 approval.
      const ready = await Promise.all([pool.token0, pool.token1].map(async (token, index) => {
        const needed = index === 0 ? mint.amount0Max : mint.amount1Max;
        if (token.address === zeroAddress) {
          return await client.getBalance({ address: loaded.wallet.address, blockNumber }) >= needed;
        }
        const assets = await readMonadV4TokenAssets({ client: client as MonadV3PoolClient,
          owner: loaded.wallet.address, token: token.address, blockNumber });
        return assets.balance >= needed && assets.erc20Allowance >= needed &&
          assets.permit2Allowance >= needed && assets.permit2Expiration > mint.deadline;
      }));
      if (ready.includes(false)) return finish("rejected", "MINT_ASSETS_OR_ALLOWANCES_CHANGED");
    } else {
      const stored = loaded.monadV4PositionAction;
      if (!stored) return finish("rejected", "POSITION_CONTEXT_MISSING");
      const position = await readMonadV4Position({ client: client as MonadV3PoolClient,
        owner: loaded.wallet.address, tokenId: stored.tokenId, blockNumber });
      pool = position.pool;
      if (pool.id.toLowerCase() !== stored.poolId.toLowerCase() ||
          position.tickLower !== stored.tickLower ||
          position.tickUpper !== stored.tickUpper ||
          position.liquidity !== stored.liquidity ||
          `monad_v4_position_${stored.kind}` !== loaded.kind) {
        return finish("rejected", "POSITION_CHANGED");
      }
      expected = buildMonadV4PositionAction({ kind: stored.kind,
        removeBps: stored.kind === "decrease" ? stored.removeBps : undefined,
        position: { ...position, pool: { ...position.pool, ...stored.snapshot } },
        recipient: stored.recipient, slippageBps: stored.slippageBps,
        deadline: stored.deadline });
    }
    await client.call({ account: loaded.wallet.address, to: loaded.transaction.to,
      data: loaded.transaction.data, value: loaded.transaction.value, blockNumber });
    if (loaded.automation) {
      const approval = loaded.monadV4Approval, mint = loaded.monadV4Mint, action = loaded.monadV4PositionAction;
      const amounts = mint ? { amount0: mint.amount0Max, amount1: mint.amount1Max } : approval
        ? { amount0: approval.token.toLowerCase() === pool.token0.address.toLowerCase() ? approval.amount : 0n,
          amount1: approval.token.toLowerCase() === pool.token1.address.toLowerCase() ? approval.amount : 0n }
        : { amount0: 0n, amount1: 0n };
      const reason = monadAutomationReason(loaded, pool, await readMonUsd(client as MonadV3PoolClient, blockNumber).catch(() => null),
        { ...amounts, tokenId: action?.tokenId, tickLower: mint?.tickLower, tickUpper: mint?.tickUpper });
      if (reason) return finish('rejected', reason);
    }
    const decision = validateMonadV4Intent({ now, emergencyStop: input.emergencyStop,
      wallet: loaded.wallet, intent: { kind: loaded.kind, status: loaded.status,
        expiresAt: loaded.expiresAt, payloadHash: loaded.payloadHash },
      transaction: loaded.transaction, pool, expected,
      simulation: { success: true, blockNumber, latestBlockNumber: blockNumber } });
    return finish(decision.allowed ? "allowed" : "rejected", decision.reason);
  } catch (error) {
    console.error("Monad v4 chain revalidation failed for intent:", loaded.intentId, error);
    return finish("rejected", "CHAIN_REVALIDATION_FAILED");
  }
}

async function evaluateMonadWithdrawalLoaded(input: {
  loaded: LoadedMainnetIntent;
  client: MainnetAuditClient;
  blockNumber: bigint;
  now: number;
}): Promise<MainnetEvaluation> {
  const { loaded, client, blockNumber, now } = input;
  const finish = (decision: "allowed" | "rejected", reasonCode: string): MainnetEvaluation => ({
    intentId: loaded.intentId, decision, reasonCode, blockNumber: Number(blockNumber), createdAt: now,
  });
  if (loaded.kind !== "monad_withdrawal" || !loaded.monadWithdrawal) {
    return finish("rejected", "WITHDRAWAL_CONTEXT_MISSING");
  }
  if (loaded.automation) return finish("rejected", "AUTOMATION_NOT_ALLOWED");
  const authorization = loaded.monadWithdrawal;
  try {
    if (authorization.transaction.asset === zeroAddress) {
      const balance = await client.getBalance({ address: loaded.wallet.address, blockNumber });
      if (balance < authorization.transaction.amount) {
        return finish("rejected", "WITHDRAWAL_BALANCE_INSUFFICIENT");
      }
      await client.call({ account: loaded.wallet.address, to: loaded.transaction.to,
        data: loaded.transaction.data, value: loaded.transaction.value, blockNumber });
    } else {
      const code = await client.getCode?.({ address: authorization.transaction.asset, blockNumber });
      if (!code || code === "0x") {
        return finish("rejected", "WITHDRAWAL_ASSET_NOT_CONTRACT");
      }
      const balance = await client.readContract({ address: authorization.transaction.asset,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view",
          inputs: [{ type: "address", name: "account" }],
          outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf", args: [loaded.wallet.address], blockNumber });
      if (typeof balance !== "bigint" || balance < authorization.transaction.amount) {
        return finish("rejected", "WITHDRAWAL_BALANCE_INSUFFICIENT");
      }
      const simulation = await client.simulateContract({ address: authorization.transaction.asset,
        abi: erc20TransferAbi, functionName: "transfer",
        args: [authorization.transaction.recipient, authorization.transaction.amount],
        account: loaded.wallet.address, blockNumber });
      if (simulation.result !== true) return finish("rejected", "WITHDRAWAL_TOKEN_TRANSFER_FAILED");
    }
    const decision = validateMonadWithdrawal({ now, wallet: loaded.wallet,
      intent: { status: loaded.status, expiresAt: loaded.expiresAt,
        payloadHash: loaded.payloadHash }, transaction: loaded.transaction,
      withdrawal: { transaction: authorization.transaction },
      simulation: { success: true, blockNumber, latestBlockNumber: blockNumber } });
    return finish(decision.allowed ? "allowed" : "rejected", decision.reason);
  } catch (error) {
    console.error("Monad withdrawal revalidation failed for intent:", loaded.intentId, error);
    return finish("rejected", "CHAIN_REVALIDATION_FAILED");
  }
}
