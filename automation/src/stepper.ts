import { zeroAddress, type Address, type Hex } from 'viem';
import { BANDS, bandTicks, rebalanceSwap, tickToPrice, buildMonadV4Mint, type Band } from '@tideweave/chain';
import { ApiCallError, SLIPPAGE_BPS, type AgentApi, type Prepared, type VenueName } from './agent-api';

export type RunPlan = { runId: string; walletId: string; walletAddress: Address; mandateId: string; venue: VenueName;
  poolId: Hex; tokenId: string; kind: 'rebalance' | 'close'; band: Band; revokeMandate: boolean };
export type RunState = RunPlan & { startedAt: number; done: string[]; baseline?: { amount0: string; amount1: string };
  proceeds?: { amount0: string; amount1: string }; caps?: { amount0: string; amount1: string };
  ticks?: { tickLower: number; tickUpper: number }; safeAfter?: number;
  pending?: Prepared & { step: string; sent?: boolean; attemptId?: string; transactionHash?: Hex };
  swap?: { side: 0 | 1; amountIn: string; minimumOut: string };
  finished?: Exclude<Outcome, { kind: 'wait' }> };
export type Outcome = { kind: 'wait'; state: RunState; delayMs: number } | { kind: 'done'; state?: RunState } | { kind: 'failed'; reason: string };
export const RUN_TIMEOUT_MS = 30 * 60_000;
export const isV3Pool = (id: string) => /^0x[0-9a-fA-F]{40}$/.test(id);
export const startState = (plan: RunPlan, now: number): RunState => ({ ...plan, startedAt: now, done: [] });
const wait = (state: RunState, delayMs = 4_000): Outcome => ({ kind: 'wait', state, delayMs });
const positive = (value: bigint) => value > 0n ? value : 0n;
const min = (a: bigint, b: bigint) => a < b ? a : b;

/** Persist the send marker before making the execute request, so crashes can only recover, never resubmit. */
export async function advance(input: RunState, api: AgentApi, now: number,
  persist: (state: RunState) => Promise<void> = async () => {}): Promise<Outcome> {
  let state = { ...input, done: [...input.done] };
  try {
    if (state.pending) {
      const pending = state.pending;
      if (!pending.attemptId) {
        if (pending.sent) {
          const recovered = await api.attempt(pending.intentId);
          if (!recovered.attempt) {
            if (['failed', 'rejected', 'expired'].includes(recovered.status)) return { kind: 'failed', reason: recovered.status.toUpperCase() };
            return wait(state, 10_000);
          }
          return wait({ ...state, pending: { ...pending, attemptId: recovered.attempt.attemptId, transactionHash: recovered.attempt.transactionHash } });
        }
        state = { ...state, pending: { ...pending, sent: true } };
        await persist(state);
        try {
          const result = await api.execute(pending.intentId);
          return wait({ ...state, pending: { ...state.pending!, attemptId: result.attemptId, transactionHash: result.transactionHash } });
        } catch (error) {
          if (error instanceof ApiCallError && (error.code === 'WALLET_EXECUTION_BUSY' || error.status === 429)) {
            // Explicit rejection happened before forwarding to the signer.
            return wait({ ...state, pending: { ...pending, sent: false } }, error.status === 429 ? error.retryAfter * 1000 : 4_000);
          }
          if (error instanceof ApiCallError && error.status < 500) return { kind: 'failed', reason: error.code };
          return wait(state, 10_000);
        }
      }
      const result = await api.reconcile(pending.attemptId);
      if (['submitted', 'pending'].includes(result.status)) return wait(state);
      if (result.status === 'replaced') {
        const recovered = await api.attempt(pending.intentId);
        return recovered.attempt ? wait({ ...state, pending: { ...pending, attemptId: recovered.attempt.attemptId,
          transactionHash: recovered.attempt.transactionHash } }) : wait(state);
      }
      if (result.status !== 'confirmed') return { kind: 'failed', reason: result.reasonCode ?? 'TRANSACTION_FAILED' };
      const recovered = await api.attempt(pending.intentId);
      if (recovered.attempt?.blockNumber == null) return wait(state);
      if (pending.step === 'close') state.proceeds = { amount0: pending.minimum0!, amount1: pending.minimum1! };
      if (pending.step === 'swap' && state.proceeds && state.swap) {
        const values = [BigInt(state.proceeds.amount0), BigInt(state.proceeds.amount1)];
        values[state.swap.side] -= BigInt(state.swap.amountIn);
        values[1 - state.swap.side] += BigInt(state.swap.minimumOut);
        state.proceeds = { amount0: values[0].toString(), amount1: values[1].toString() };
      }
      state = { ...state, safeAfter: recovered.attempt.blockNumber, pending: undefined, done: [...state.done, pending.step] };
      await persist(state);
    }
    if (now - state.startedAt > RUN_TIMEOUT_MS) return { kind: 'failed', reason: 'RUN_TIMED_OUT' };
    if (state.done.includes('mint') || (state.kind === 'close' && state.done.includes('close'))) return { kind: 'done', state };
    const assets = await api.assets(state.venue, state.poolId);
    if ('manualPending' in assets && assets.manualPending) return wait(state);
    if (state.safeAfter !== undefined && BigInt(assets.blockNumber) < BigInt(state.safeAfter)) return wait(state);
    const pool = await api.pool(state.venue, state.poolId);
    if (!state.baseline) state.baseline = { amount0: assets.token0.balance, amount1: assets.token1.balance };
    const pending = (prepared: Prepared, step: string) => wait({ ...state, pending: { ...prepared, step } }, 100);
    if (!state.done.includes('close')) {
      const prepared = await api.close(state.venue, state.tokenId, `${state.runId}:close`);
      if (prepared.minimum0 === undefined || prepared.minimum1 === undefined) throw new ApiCallError('CLOSE_PROCEEDS_UNAVAILABLE', 422);
      return pending(prepared, 'close');
    }
    const held = [BigInt(assets.token0.balance), BigInt(assets.token1.balance)];
    const base = [BigInt(state.baseline.amount0), BigInt(state.baseline.amount1)];
    const proceeds = [BigInt(state.proceeds!.amount0), BigInt(state.proceeds!.amount1)];
    const available = held.map((amount, i) => positive(min(proceeds[i], amount - base[i])));
    state.caps = { amount0: available[0].toString(), amount1: available[1].toString() };
    if (!state.ticks) state.ticks = bandTicks({ spotPrice: tickToPrice(pool.tick, pool.token0.decimals, pool.token1.decimals),
      spread: BANDS[state.band], tokenDecimals: pool.token0.decimals, usdcDecimals: pool.token1.decimals,
      usdcIsPoolToken0: false, tickSpacing: pool.tickSpacing });
    await persist(state);
    if (!state.done.includes('swap')) {
      const swap = rebalanceSwap({ sqrtPriceX96: pool.sqrtPriceX96, ...state.ticks, tokenIsZero: true,
        token: available[0], usdc: available[1] });
      if (swap && swap.amountIn > 0n) {
        const side = swap.from === 'token' ? 0 : 1;
        const token = side === 0 ? pool.token0.address : pool.token1.address;
        const quote = await api.quote(state.venue, state.poolId, token, swap.amountIn.toString());
        for (const allowance of quote.allowances) {
          const step = `swap-${allowance.stage}-${token}`;
          if (BigInt(allowance.allowance) < swap.amountIn || (allowance.expiration && Number(allowance.expiration) <= now / 1000 + 600)) {
            if (state.done.includes(step)) return wait(state);
            return pending(await api.approveSwap(state.venue, state.poolId, token, swap.amountIn.toString(), allowance.stage,
              `${state.runId}:${step}`), step);
          }
        }
        state.swap = { side, amountIn: swap.amountIn.toString(), minimumOut: quote.amountOutMinimum };
        await persist(state);
        const prepared = await api.swap(state.venue, state.poolId, token, swap.amountIn.toString(), `${state.runId}:swap`);
        if (!prepared.minimumOut) throw new ApiCallError('SWAP_MINIMUM_UNAVAILABLE', 422);
        state.swap.minimumOut = prepared.minimumOut;
        return pending(prepared, 'swap');
      }
      state.done.push('swap');
    }
    let [amount0, amount1] = available;
    if (amount0 <= 0n || amount1 <= 0n) throw new ApiCallError('NOTHING_TO_REOPEN', 422);
    let maxima = [amount0, amount1];
    if (state.venue === 'uniswap-v4') {
      const live = { ...pool, chainId: 143 as const, venue: 'uniswap-v4' as const, sqrtPriceX96: BigInt(pool.sqrtPriceX96), liquidity: BigInt(pool.liquidity),
        currency0: pool.token0.address, currency1: pool.token1.address, hooks: pool.hooks ?? zeroAddress, lpFee: pool.lpFee ?? pool.fee };
      for (let i = 0; i < 5; i++) {
        const mint = buildMonadV4Mint({ pool: live, recipient: state.walletAddress, ...state.ticks,
          amount0Desired: amount0, amount1Desired: amount1, slippageBps: SLIPPAGE_BPS, deadline: BigInt(Math.floor(now / 1000) + 600) });
        maxima = [mint.amount0Max, mint.amount1Max];
        if (maxima[0] <= available[0] && maxima[1] <= available[1]) break;
        const factor = min(available[0] * 1_000_000n / maxima[0], available[1] * 1_000_000n / maxima[1]);
        amount0 = amount0 * factor / 1_000_000n; amount1 = amount1 * factor / 1_000_000n;
      }
      if (maxima[0] > available[0] || maxima[1] > available[1]) throw new ApiCallError('NOTHING_TO_REOPEN', 422);
    }
    const allowances = await api.mintAllowances(state.venue, state.poolId);
    for (const [i, token] of [pool.token0.address, pool.token1.address].entries()) {
      if (token === zeroAddress) continue;
      for (const layer of state.venue === 'uniswap-v3' ? ['erc20'] as const : ['erc20', 'permit2'] as const) {
        const allowance = allowances.find(a => a.token.toLowerCase() === token.toLowerCase() && a.stage === layer);
        if (!allowance || BigInt(allowance.allowance) < maxima[i] || (allowance.expiration && Number(allowance.expiration) <= now / 1000 + 600)) {
          const step = `mint-${layer}-${token}`;
          if (state.done.includes(step)) return wait(state);
          return pending(await api.approveMint(state.venue, state.poolId, token, maxima[i].toString(), layer, `${state.runId}:${step}`), step);
        }
      }
    }
    return pending(await api.mint(state.venue, state.poolId, { amount0Desired: amount0.toString(), amount1Desired: amount1.toString() },
      state.ticks, `${state.runId}:mint`), 'mint');
  } catch (error) {
    if (!(error instanceof ApiCallError) || error.status >= 500 || error.status === 429) {
      return wait(state, error instanceof ApiCallError && error.status === 429 ? Math.max(1, error.retryAfter) * 1000 : 10_000);
    }
    return { kind: 'failed', reason: error.code };
  }
}
