import { getAddress, type Hex } from "viem";
import { buildMonadWithdrawal,
  MONAD_CHAIN_ID,
  UNISWAP_V4_MONAD } from "@tideweave/chain";
import { isMonadV4IntentKind } from "./monad-v4-policy";
import { isNadIntentKind } from "./monad-nadfun-policy";
import { loadNadIntent } from "./monad-nadfun-store";
import { isSwapIntentKind } from "./monad-swap-policy";
import { loadSwapIntent } from "./monad-swap-store";
import { isWrapIntentKind } from "./monad-wrap-policy";
import { loadWrapIntent } from "./monad-wrap-store";
import type {
  LoadedMainnetIntent,
  MainnetEvaluation,
  MainnetEvaluationStore,
} from "./mainnet-evaluator";
import type { MainnetIntentKind } from "./mainnet-policy";
import type { WalletState } from "./policy";

type Row = {
  intent_id: string;
  kind: MainnetIntentKind;
  status: string;
  expires_at: number;
  payload_hash: Hex;
  wallet_address: string;
  wallet_state: WalletState;
  approval_chain_id: number | null;
  approval_target: string | null;
  approval_pool_address: string | null;
  approval_pool_token_address: string | null;
  approval_token_decimals: number | null;
  approval_calldata: Hex | null;
  mint_chain_id: number | null;
  mint_target: string | null;
  mint_calldata: Hex | null;
  mint_pool_address: string | null;
  mint_token0_address: string | null;
  mint_token1_address: string | null;
  mint_fee: number | null;
  mint_tick_spacing: number | null;
  mint_token_decimals: number | null;
  action_chain_id: number | null;
  action_target: string | null;
  action_calldata: Hex | null;
  action_token_id: string | null;
  monad_withdrawal_chain_id: number | null;
  monad_withdrawal_asset: string | null;
  monad_withdrawal_target: string | null;
  monad_withdrawal_calldata: Hex | null;
  monad_withdrawal_value: string | null;
  monad_withdrawal_recipient: string | null;
  monad_withdrawal_amount: string | null;
  monad_withdrawal_nonce: Hex | null;
  monad_withdrawal_expires_at: number | null;
  constraints_json: string | null;
  wallet_id: string;
  dynamic_wallet_id: string | null;
  automation_json: string;
};

type AutomationRow = {
  run_id: string | null;
  run_status: string | null;
  mandate_id: string | null;
  mandate_status: string | null;
  mandate_pool_id: Hex | null;
  mandate_max_position_usd: number | null;
  mandate_max_runs_per_day: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

const allowedKinds = new Set<string>([
  "monad_v3_approval",
  "monad_v3_mint",
  "monad_v3_position_increase",
  "monad_v3_position_decrease",
  "monad_v3_position_collect",
  "monad_v3_position_withdraw",
  "monad_v4_approval",
  "monad_v4_mint",
  "monad_v4_position_collect",
  "monad_v4_position_decrease",
  "monad_v4_position_withdraw",
  "monad_nadfun_add",
  "monad_nadfun_remove",
  "monad_delegation_clear",
  "monad_swap",
  "monad_swap_approval",
  "monad_wrap",
  "monad_unwrap",
  "monad_withdrawal",
]);

export class D1MainnetEvaluationStore implements MainnetEvaluationStore {
  constructor(private readonly db: D1Database) {}

  async load(intentId: string): Promise<LoadedMainnetIntent | null> {
    const row = await this.db.prepare(
      `SELECT wi.id AS intent_id, wi.kind, wi.status, wi.expires_at,
              wi.payload_hash, mw.address AS wallet_address,
              mw.state AS wallet_state,
              mw.id AS wallet_id, mw.dynamic_wallet_id,
              ai.chain_id AS approval_chain_id,
              ai.token_address AS approval_target,
              ai.pool_address AS approval_pool_address,
              ai.pool_token_address AS approval_pool_token_address,
              ai.token_decimals AS approval_token_decimals,
              ai.calldata AS approval_calldata,
              mi.chain_id AS mint_chain_id,
              mi.position_manager AS mint_target,
              mi.calldata AS mint_calldata,
              mi.pool_address AS mint_pool_address,
              mi.token0_address AS mint_token0_address,
              mi.token1_address AS mint_token1_address,
              mi.fee AS mint_fee,
              mi.tick_spacing AS mint_tick_spacing,
              mi.token_decimals AS mint_token_decimals,
              pai.chain_id AS action_chain_id,
              pai.position_manager AS action_target,
              pai.calldata AS action_calldata,
              pai.token_id AS action_token_id,
              pai.constraints_json,
              mwi.chain_id AS monad_withdrawal_chain_id,
              mwi.asset_address AS monad_withdrawal_asset,
              mwi.target_address AS monad_withdrawal_target,
              mwi.calldata AS monad_withdrawal_calldata,
              mwi.native_value AS monad_withdrawal_value,
              mwi.recipient AS monad_withdrawal_recipient,
              mwi.amount AS monad_withdrawal_amount,
              mwi.nonce AS monad_withdrawal_nonce,
              mwi.expires_at AS monad_withdrawal_expires_at,
              json_object('run_id', wi.automation_run_id, 'run_status', ar.status,
                'mandate_id', am.id, 'mandate_status', am.status, 'mandate_pool_id', am.pool_id,
                'mandate_max_position_usd', am.max_position_usd,
                'mandate_max_runs_per_day', am.max_runs_per_day) AS automation_json
       FROM wallet_intents wi
       JOIN managed_wallets mw ON mw.id = wi.wallet_id
       JOIN users u ON u.id = mw.user_id
       LEFT JOIN approval_intents ai ON ai.intent_id = wi.id
       LEFT JOIN mint_intents mi ON mi.intent_id = wi.id
       LEFT JOIN position_action_intents pai ON pai.intent_id = wi.id
       LEFT JOIN monad_withdrawal_intents mwi ON mwi.intent_id = wi.id
       LEFT JOIN automation_runs ar ON ar.id = wi.automation_run_id
       LEFT JOIN automation_mandates am ON am.id = ar.mandate_id
       WHERE wi.id = ?1`,
    ).bind(intentId).first<Row>();
    if (!row || !allowedKinds.has(row.kind)) return null;
    if (isMonadV4IntentKind(row.kind)) return this.loadMonadV4(row);
    if (isNadIntentKind(row.kind) || isSwapIntentKind(row.kind) || isWrapIntentKind(row.kind)) {
      const walletAddress = getAddress(row.wallet_address);
      const load = isSwapIntentKind(row.kind) ? loadSwapIntent : isWrapIntentKind(row.kind) ? loadWrapIntent : loadNadIntent;
      return load(this.db, { intentId: row.intent_id, kind: row.kind, status: row.status,
        expiresAt: row.expires_at, payloadHash: row.payload_hash,
        wallet: { address: walletAddress, state: row.wallet_state },
        custody: row.dynamic_wallet_id ? { walletId: row.wallet_id, dynamicWalletId: row.dynamic_wallet_id,
          address: walletAddress } : undefined,
        automation: await this.loadAutomation(JSON.parse(row.automation_json) as AutomationRow, row.wallet_address) });
    }

    const chainId = row.approval_chain_id ?? row.mint_chain_id ?? row.action_chain_id ?? row.monad_withdrawal_chain_id;
    const target = row.approval_target ?? row.mint_target ?? row.action_target ?? row.monad_withdrawal_target;
    const data = row.approval_calldata ?? row.mint_calldata ?? row.action_calldata ?? row.monad_withdrawal_calldata;
    if (chainId !== MONAD_CHAIN_ID || target === null || data === null) return null;
    let expected0: bigint | undefined;
    let expected1: bigint | undefined;
    let actionPoolAddress: `0x${string}` | undefined;
    if (row.constraints_json) {
      const constraints = JSON.parse(row.constraints_json) as Record<string, unknown>;
      if (typeof constraints.expected0 === "string") {
        expected0 = BigInt(constraints.expected0);
      }
      if (typeof constraints.expected1 === "string") {
        expected1 = BigInt(constraints.expected1);
      }
      if (typeof constraints.poolAddress === "string") {
        actionPoolAddress = getAddress(constraints.poolAddress);
      }
    }
    const approvalPool = row.approval_target && row.approval_pool_address
      ? {
          tokenAddress: getAddress(row.approval_target),
          poolAddress: getAddress(row.approval_pool_address),
          poolTokenAddress: getAddress(row.approval_pool_token_address ?? row.approval_target),
          ...(row.approval_token_decimals === null ? {} : { tokenDecimals: row.approval_token_decimals }),
        }
      : undefined;
    const automation = await this.loadAutomation(JSON.parse(row.automation_json) as AutomationRow, row.wallet_address);
    const mintPool = row.mint_pool_address && row.mint_token0_address && row.mint_token1_address &&
      row.mint_fee !== null && row.mint_tick_spacing !== null
      ? {
          poolAddress: getAddress(row.mint_pool_address),
          token0: getAddress(row.mint_token0_address),
          token1: getAddress(row.mint_token1_address),
          fee: row.mint_fee,
          tickSpacing: row.mint_tick_spacing,
          ...(row.mint_token_decimals === null ? {} : { tokenDecimals: row.mint_token_decimals }),
        }
      : undefined;
    return {
      intentId: row.intent_id,
      kind: row.kind,
      status: row.status,
      expiresAt: row.expires_at,
      payloadHash: row.payload_hash,
      wallet: { address: getAddress(row.wallet_address), state: row.wallet_state },
      transaction: {
        chainId,
        to: getAddress(target),
        data,
        value: row.monad_withdrawal_value !== null ? BigInt(row.monad_withdrawal_value) : 0n,
      },
      approvalPool,
      mintPool,
      tokenId: row.action_token_id === null ? undefined : BigInt(row.action_token_id),
      expected0,
      expected1,
      actionPoolAddress,
      monadWithdrawal: row.monad_withdrawal_asset && row.monad_withdrawal_recipient &&
        row.monad_withdrawal_amount && row.monad_withdrawal_nonce && row.monad_withdrawal_expires_at
        ? {
            transaction: buildMonadWithdrawal({ wallet: getAddress(row.wallet_address),
              asset: getAddress(row.monad_withdrawal_asset),
              recipient: getAddress(row.monad_withdrawal_recipient),
              amount: BigInt(row.monad_withdrawal_amount),
              nonce: row.monad_withdrawal_nonce,
              expiresAt: BigInt(row.monad_withdrawal_expires_at) }),
          }
        : undefined,
      custody: row.dynamic_wallet_id
        ? {
            walletId: row.wallet_id,
            dynamicWalletId: row.dynamic_wallet_id,
            address: getAddress(row.wallet_address),
          }
        : undefined,
      automation,
    };
  }

  private async loadMonadV4(row: Row): Promise<LoadedMainnetIntent | null> {
    const walletAddress = getAddress(row.wallet_address);
    const common = {
      intentId: row.intent_id, kind: row.kind, status: row.status,
      expiresAt: row.expires_at, payloadHash: row.payload_hash,
      wallet: { address: walletAddress, state: row.wallet_state },
      custody: row.dynamic_wallet_id ? { walletId: row.wallet_id,
        dynamicWalletId: row.dynamic_wallet_id, address: walletAddress } : undefined,
      automation: await this.loadAutomation(JSON.parse(row.automation_json) as AutomationRow, row.wallet_address),
    };
    if (row.kind === "monad_v4_approval") {
      const approval = await this.db.prepare(
        "SELECT * FROM monad_v4_approval_intents WHERE intent_id = ?1",
      ).bind(row.intent_id).first<{
        pool_id: Hex; currency0: string; currency1: string; fee: number;
        tick_spacing: number; hooks: string; token: string; token_decimals: number;
        stage: "erc20" | "permit2"; amount: string; expiration: string;
        target: string; calldata: Hex;
      }>();
      if (!approval) return null;
      return { ...common, transaction: { chainId: MONAD_CHAIN_ID,
        to: getAddress(approval.target), data: approval.calldata, value: 0n },
        monadV4Approval: { poolId: approval.pool_id,
          key: { currency0: getAddress(approval.currency0),
            currency1: getAddress(approval.currency1), fee: approval.fee,
            tickSpacing: approval.tick_spacing, hooks: getAddress(approval.hooks) },
          token: getAddress(approval.token), tokenDecimals: approval.token_decimals,
          stage: approval.stage, amount: BigInt(approval.amount),
          expiration: BigInt(approval.expiration) } };
    }
    if (row.kind === "monad_v4_mint") {
      const mint = await this.db.prepare(
        "SELECT * FROM monad_v4_mint_intents WHERE intent_id = ?1",
      ).bind(row.intent_id).first<{
        pool_id: Hex; currency0: string; currency1: string; fee: number;
        tick_spacing: number; hooks: string;
        token0_decimals: number; token1_decimals: number;
        sqrt_price_x96: string; tick: number; liquidity: string; lp_fee: number;
        recipient: string; tick_lower: number; tick_upper: number;
        amount0_desired: string; amount1_desired: string;
        amount0_max: string; amount1_max: string;
        slippage_bps: number; deadline: string; calldata: Hex; value: string | null;
      }>();
      if (!mint) return null;
      return { ...common, transaction: { chainId: MONAD_CHAIN_ID,
        to: UNISWAP_V4_MONAD.positionManager, data: mint.calldata, value: BigInt(mint.value ?? "0") },
        monadV4Mint: { poolId: mint.pool_id,
          key: { currency0: getAddress(mint.currency0),
            currency1: getAddress(mint.currency1), fee: mint.fee,
            tickSpacing: mint.tick_spacing, hooks: getAddress(mint.hooks) },
          token0Decimals: mint.token0_decimals, token1Decimals: mint.token1_decimals,
          snapshot: { sqrtPriceX96: BigInt(mint.sqrt_price_x96), tick: mint.tick,
            liquidity: BigInt(mint.liquidity), lpFee: mint.lp_fee },
          recipient: getAddress(mint.recipient), tickLower: mint.tick_lower,
          tickUpper: mint.tick_upper,
          amount0Desired: BigInt(mint.amount0_desired),
          amount1Desired: BigInt(mint.amount1_desired),
          amount0Max: BigInt(mint.amount0_max), amount1Max: BigInt(mint.amount1_max),
          slippageBps: mint.slippage_bps, deadline: BigInt(mint.deadline) } };
    }
    const action = await this.db.prepare(
      "SELECT * FROM monad_v4_position_action_intents WHERE intent_id = ?1",
    ).bind(row.intent_id).first<{
      action: "collect" | "decrease" | "withdraw"; remove_bps: number; pool_id: Hex; token_id: string;
      tick_lower: number; tick_upper: number; liquidity: string;
      slippage_bps: number; deadline: string; recipient: string; calldata: Hex;
      sqrt_price_x96: string; tick: number; pool_liquidity: string; lp_fee: number;
    }>();
    if (!action) return null;
    return { ...common, transaction: { chainId: MONAD_CHAIN_ID,
      to: UNISWAP_V4_MONAD.positionManager, data: action.calldata, value: 0n },
      monadV4PositionAction: { kind: action.action, removeBps: action.remove_bps, poolId: action.pool_id,
        tokenId: BigInt(action.token_id), tickLower: action.tick_lower,
        tickUpper: action.tick_upper, liquidity: BigInt(action.liquidity),
        slippageBps: action.slippage_bps, deadline: BigInt(action.deadline),
        recipient: getAddress(action.recipient),
        snapshot: { sqrtPriceX96: BigInt(action.sqrt_price_x96), tick: action.tick,
          liquidity: BigInt(action.pool_liquidity), lpFee: action.lp_fee } } };
  }

  /** The run and mandate behind an agent's request; undefined when the user made it. */
  private async loadAutomation(row: AutomationRow, walletAddress: string): Promise<LoadedMainnetIntent["automation"]> {
    if (row.run_id === null) return undefined;
    const mandate = row.mandate_id !== null && row.mandate_status !== null && row.mandate_pool_id !== null &&
      row.mandate_max_position_usd !== null && row.mandate_max_runs_per_day !== null
      ? { status: row.mandate_status, poolId: row.mandate_pool_id,
          maxPositionUsd: row.mandate_max_position_usd, maxRunsPerDay: row.mandate_max_runs_per_day }
      : null;
    const started = mandate === null ? null : await this.db.prepare(
      "SELECT COUNT(*) AS runs FROM automation_runs WHERE mandate_id = ?1 AND started_at >= ?2",
    ).bind(row.mandate_id, Date.now() - DAY_MS).first<{ runs: number }>();
    const details = await this.db.prepare(`SELECT am.venue, ar.token_id, ar.band, am.band AS mandate_band, ar.state_json,
      CASE WHEN ar.wallet_id = am.wallet_id AND ar.token_id = am.token_id AND mw.address = ?2 COLLATE NOCASE THEN 1 ELSE 0 END AS wallet_matches
      FROM automation_runs ar JOIN automation_mandates am ON am.id = ar.mandate_id
      JOIN managed_wallets mw ON mw.id = am.wallet_id WHERE ar.id = ?1`)
      .bind(row.run_id, walletAddress).first<{ venue: string; token_id: string; band: string;
        mandate_band: string; state_json: string | null; wallet_matches: number }>();
    const confirmed = details ? (await this.db.prepare(`SELECT wi.kind,
      COALESCE(pa.calldata, vpa.calldata) AS calldata, si.token_in, si.amount_in, si.amount_out_minimum
      FROM wallet_intents wi LEFT JOIN position_action_intents pa ON pa.intent_id = wi.id
      LEFT JOIN monad_v4_position_action_intents vpa ON vpa.intent_id = wi.id
      LEFT JOIN monad_swap_intents si ON si.intent_id = wi.id
      WHERE wi.automation_run_id = ?1 AND wi.status = 'confirmed' ORDER BY wi.created_at LIMIT 100`)
      .bind(row.run_id).all<{ kind: string; calldata: Hex | null; token_in: string | null; amount_in: string | null; amount_out_minimum: string | null }>()).results ?? [] : [];
    let state = null;
    try { state = details?.state_json ? JSON.parse(details.state_json) : null; } catch { /* Malformed state fails closed. */ }
    return { runId: row.run_id, runStatus: row.run_status, mandate, runsStartedToday: started?.runs ?? 0,
      monad: details ? { venue: details.venue, tokenId: details.token_id, band: details.band,
        mandateBand: details.mandate_band, state, confirmed, walletMatches: details.wallet_matches === 1 } : undefined };
  }

  async save(value: MainnetEvaluation): Promise<void> {
    await this.db.prepare(
      `INSERT INTO mainnet_policy_evaluations (
        id, intent_id, decision, reason_code, block_number, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      `evaluation_${crypto.randomUUID()}`,
      value.intentId,
      value.decision,
      value.reasonCode,
      value.blockNumber,
      value.createdAt,
    ).run();
  }
}
