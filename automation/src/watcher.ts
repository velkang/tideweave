import type { Address, Hex } from "viem";
import { amountsForLiquidity, anchorSide, automationValue, readMonUsd, readMonadV3Position, readMonadV4Position,
  readV3Fees, readV4Fees, tickToPrice, type MonadV3PoolClient, type FeeCallClient } from '@tideweave/chain';
import type { VenueName } from './agent-api';
import type { DecisionFacts } from "./decide/decision";
import { decide, type Decider } from "./decide/provider";
import { startState, type RunPlan } from "./stepper";
import {
  HOUR,
  asked,
  emptyMemory,
  observe,
  priceAgo,
  shouldAsk,
  triggerFor,
  type MandateMemory,
} from "./watch";

// One look at every position a wallet has handed to the agent: read it, remember the price,
// and ask the model only when something calls for it. A decision to act becomes a proposal
// (ask-first) or a run that starts now (autopilot); the signer still checks every step.

export type WatchState = { memories: Record<string, MandateMemory> };
export type WatchChain = MonadV3PoolClient & FeeCallClient & {
  getGasPrice(): Promise<bigint>;
  getBlock(input: { blockTag: 'safe' }): Promise<{ number: bigint | null }>;
};
export type Deciders = { primary: Decider };
export type WatchResult = { state: WatchState; stop: boolean; start?: RunPlan };

type Mandate = {
  id: string;
  pool_id: Hex;
  venue: VenueName;
  token_id: string;
  mode: "ask" | "autopilot";
  band: "wide" | "balanced" | "narrow" | "agent";
  max_position_usd: number;
  max_runs_per_day: number;
};

const DAY = 24 * HOUR;
// Below this, a re-centre's fees cost more than the band holds: not worth asking the model.
const MIN_WORTH_USD = 1;
// A mandate the user set must cover the position with this much room, or reopening is refused.
const LIMIT_HEADROOM = 1.1;
// No run lasts this long (the stepper gives up after 30 minutes); one still "running" was lost.

// Rough gas for a whole re-centre (close, swap, approvals, reopen), to weigh against fees.
const RECENTRE_GAS = 1_500_000n;


export async function watchWallet(walletId: string, input: WatchState, deps: {
  db: D1Database;
  chain: WatchChain;
  deciders: Deciders | null;
  now: number;
  /** Takes one model call from today's budget; false once it's used up. */
  reserveCall?: () => Promise<boolean>;
}): Promise<WatchResult> {
  const { db, chain, now } = deps;
  const wallet = await db.prepare("SELECT id, address, state FROM managed_wallets WHERE id = ?1")
    .bind(walletId).first<{ id: string; address: Address; state: string }>();
  const mandates = wallet?.state === "active" ? (await db.prepare(
    `SELECT id, pool_id, venue, token_id, mode, band, max_position_usd, max_runs_per_day FROM automation_mandates
     WHERE wallet_id = ?1 AND status = 'active' AND venue IS NOT NULL AND token_id IS NOT NULL`,
  ).bind(walletId).all<Mandate>()).results ?? [] : [];
  if (!wallet || mandates.length === 0) return { state: { memories: {} }, stop: true };

  // Forget mandates that ended; keep the rest.
  const memories: Record<string, MandateMemory> = {};
  for (const mandate of mandates) memories[mandate.id] = input.memories[mandate.id] ?? emptyMemory();

  for (const mandate of mandates) {
    try {
      const look = await lookAt(mandate, wallet.address, walletId, deps);
      if (!look) continue;
      let memory = observe(memories[mandate.id]!, { now, price: look.priceRatio, inBand: look.inBand });
      memories[mandate.id] = memory;
      const trigger = triggerFor(memory, now);
      const worth = look.valueUsd + look.feesUsd;
      if (!trigger || !deps.deciders || worth < MIN_WORTH_USD) continue;

      const runs = await recentRuns(db, mandate.id, now);
      if (!shouldAsk({ memory, trigger, now, openRun: runs.open, lastRunFinishedAt: runs.lastFinishedAt,
        runsStartedToday: runs.startedToday, maxRunsPerDay: mandate.max_runs_per_day })) continue;

      const facts: DecisionFacts = {
        trigger,
        token: { symbol: look.symbol },
        feeTierPercent: look.feeTierPercent,
        priceRatio: look.priceRatio,
        band: { minRatio: look.minRatio, maxRatio: look.maxRatio, priceIs: look.priceIs },
        priceHistoryRatio: { "1h": priceAgo(memory, now, HOUR), "6h": priceAgo(memory, now, 6 * HOUR),
          "24h": priceAgo(memory, now, DAY) },
        position: { valueUsd: look.valueUsd, uncollectedFeesUsd: look.feesUsd },
        recentreCostUsd: look.recentreCostUsd,
        mandate: { mode: mandate.mode, band: mandate.band, maxPositionUsd: mandate.max_position_usd,
          runsLeftToday: Math.max(0, mandate.max_runs_per_day - runs.startedToday) },
      };
      const deciders = deps.reserveCall ? withBudget(deps.deciders, deps.reserveCall) : deps.deciders;
      const result = await decide(facts, deciders.primary);
      // Out of calls for today: hold, and ask again once there are calls to spare.
      if (!result.decision && result.note === "daily_limit") continue;
      memory = asked(memory, trigger, now);
      memories[mandate.id] = memory;
      const decision = result.decision;
      if (!decision || decision.action === "hold") {
        if (!decision) console.warn("Automation got no usable decision; holding", mandate.id, result.provider, result.note);
        continue;
      }

      const kind = decision.action === "close" ? "close" : "rebalance";
      // The signer would refuse the new band after the old one was closed, leaving the money idle.
      if (kind === "rebalance" && worth * LIMIT_HEADROOM > mandate.max_position_usd) {
        console.warn("Automation won't re-centre a position worth more than its mandate allows", mandate.id);
        continue;
      }
      const band = mandate.band !== "agent" ? mandate.band : decision.band ?? "balanced";
      const runId = `run_${crypto.randomUUID()}`;
      const autopilot = mandate.mode === "autopilot";
      const plan: RunPlan = { runId, walletId, walletAddress: wallet.address, mandateId: mandate.id,
        venue: mandate.venue, poolId: mandate.pool_id, tokenId: look.tokenId, band, kind, revokeMandate: false };
      try {
        await db.prepare(
          `INSERT INTO automation_runs (id, mandate_id, kind, status, band, trigger, reason, provider, model,
             token_id, created_at, started_at, updated_at, wallet_id, state_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?11, ?13, ?14)`,
        ).bind(runId, mandate.id, kind, autopilot ? "running" : "proposed", kind === "close" ? null : band,
          trigger, decision.reason, result.provider, result.model, look.tokenId, now, autopilot ? now : null, walletId, autopilot ? JSON.stringify(startState(plan, now)) : null).run();
      } catch (error) {
        // automation_runs_open: a proposal or run already exists for this mandate.
        console.warn("Automation could not record its decision", mandate.id, error);
        continue;
      }
      if (autopilot) {
        // One run per wallet at a time: start this one and look at the rest next time.
        return { state: { memories }, stop: false, start: plan };
      }
    } catch (error) {
      console.warn("Automation could not look at a position; trying again next time", mandate.id, error);
    }
  }
  return { state: { memories }, stop: false };
}

/** Only the mandate's explicitly selected, Tideweave-minted position is watched. */
async function lookAt(mandate: Mandate, owner: Address, walletId: string, deps: { db: D1Database; chain: WatchChain }) {
  const { db, chain } = deps;
  const table = mandate.venue === 'uniswap-v3' ? 'mint_intents' : 'monad_v4_mint_intents';
  const minted = await db.prepare(`SELECT mi.token_id FROM wallet_intents wi JOIN ${table} mi ON mi.intent_id = wi.id
    WHERE wi.wallet_id = ?1 AND wi.kind = ?2 AND wi.status = 'confirmed' AND mi.token_id = ?3 LIMIT 1`)
    .bind(walletId, mandate.venue === 'uniswap-v3' ? 'monad_v3_mint' : 'monad_v4_mint', mandate.token_id).first();
  if (!minted) return null;
  const safe = await chain.getBlock({ blockTag: 'safe' });
  if (safe.number === null) return null;
  const read = mandate.venue === 'uniswap-v3' ? readMonadV3Position : readMonadV4Position;
  const position = await read({ client: chain, owner, tokenId: BigInt(mandate.token_id), blockNumber: safe.number });
  const pool = position.pool;
  if (position.liquidity <= 0n || pool.id.toLowerCase() !== mandate.pool_id.toLowerCase()) return null;
  const [monUsd, gasPrice, fees] = await Promise.all([
    readMonUsd(chain, safe.number).catch(() => null), chain.getGasPrice(),
    mandate.venue === 'uniswap-v3' ? readV3Fees({ client: chain, owner, tokenId: position.tokenId, blockNumber: safe.number })
      : readV4Fees({ client: chain, poolId: pool.id as Hex, tokenId: position.tokenId,
        tickLower: position.tickLower, tickUpper: position.tickUpper, blockNumber: safe.number }),
  ]);
  if (monUsd === null) return null; // Cost of execution also needs a MON price.
  const amounts = amountsForLiquidity({ ...position, sqrtPriceX96: pool.sqrtPriceX96 });
  const valueUsd = automationValue(pool, amounts, monUsd);
  const feesUsd = automationValue(pool, fees, monUsd);
  if (valueUsd === null || feesUsd === null || anchorSide(pool, monUsd) === null) return null;
  const price = (tick: number) => tickToPrice(tick, pool.token0.decimals, pool.token1.decimals);
  const priceRatio = price(pool.tick), minRatio = price(position.tickLower), maxRatio = price(position.tickUpper);
  return { tokenId: position.tokenId.toString(), symbol: `${pool.token0.symbol} / ${pool.token1.symbol}`,
    feeTierPercent: ('lpFee' in pool ? pool.lpFee : pool.fee) / 10000,
    priceRatio, minRatio, maxRatio, inBand: pool.tick >= position.tickLower && pool.tick < position.tickUpper,
    priceIs: (priceRatio < minRatio ? 'below' : priceRatio > maxRatio ? 'above' : 'inside') as DecisionFacts['band']['priceIs'],
    valueUsd, feesUsd, recentreCostUsd: Number(gasPrice * RECENTRE_GAS) / 1e18 * monUsd };
}

/** Whether a proposal or run is open, when the last one ended, and how many started today. */
async function recentRuns(db: D1Database, mandateId: string, now: number) {
  const [latest, started] = await Promise.all([
    db.prepare(
      `SELECT id, status, created_at, started_at, finished_at FROM automation_runs WHERE mandate_id = ?1
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(mandateId).first<{ id: string; status: string; created_at: number; started_at: number | null;
      finished_at: number | null }>(),
    db.prepare("SELECT COUNT(*) AS runs FROM automation_runs WHERE mandate_id = ?1 AND started_at >= ?2")
      .bind(mandateId, now - DAY).first<{ runs: number }>(),
  ]);
  let open = latest?.status === "proposed" || latest?.status === "running";
  // A proposal nobody answered within a day lapses, so the agent can look again.
  if (latest?.status === "proposed" && latest.created_at < now - DAY) {
    await db.prepare(
      `UPDATE automation_runs SET status = 'expired', finished_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'proposed'`,
    ).bind(latest.id, now).run();
    open = false;
  }
  return { open, lastFinishedAt: latest?.finished_at ?? null, startedToday: started?.runs ?? 0 };
}

/** Each provider call takes one call from the budget first, and is skipped when there is none. */
function withBudget(deciders: Deciders, reserve: () => Promise<boolean>): Deciders {
  const limited = (decider: Decider): Decider => ({
    ...decider,
    async decide(facts) {
      if (!(await reserve())) return { provider: decider.provider, model: decider.model, decision: null, note: "daily_limit" };
      return decider.decide(facts);
    },
  });
  return { primary: limited(deciders.primary) };
}

/**
 * Counts a model call against today's (UTC) limit across all users, in one statement so
 * two wallets can't both take the last call. Nothing is written once the limit is reached.
 */
export async function reserveModelCall(db: D1Database, now: number, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const counted = await db.prepare(
    `INSERT INTO automation_model_calls (day, calls) VALUES (?1, 1)
     ON CONFLICT (day) DO UPDATE SET calls = calls + 1 WHERE calls < ?2
     RETURNING calls`,
  ).bind(new Date(now).toISOString().slice(0, 10), limit).first<{ calls: number }>();
  return counted !== null;
}
