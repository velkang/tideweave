import type { Address, Hex } from 'viem';

export type VenueName = 'uniswap-v3' | 'uniswap-v4';
export type PoolInfo = { venue: VenueName; id: Hex; token0: { address: Address; symbol: string; decimals: number };
  token1: { address: Address; symbol: string; decimals: number }; fee: number; tickSpacing: number;
  hooks?: Address; sqrtPriceX96: string; tick: number; liquidity: string; lpFee?: number };
export type Assets = { token0: { balance: string }; token1: { balance: string }; blockNumber: string };
export type Prepared = { intentId: string; minimum0?: string; minimum1?: string; minimumOut?: string };
export type Attempt = { attemptId: string; status: string; transactionHash: Hex; blockNumber: number | null;
  failureReason?: string | null };
export type Quote = { amountOutMinimum: string; approved: boolean;
  allowances: Array<{ stage: 'erc20' | 'permit2'; allowance: string; expiration?: string }> };
export interface AgentApi {
  pool(venue: VenueName, id: Hex): Promise<PoolInfo>;
  assets(venue: VenueName, id: Hex): Promise<Assets>;
  close(venue: VenueName, tokenId: string, key: string): Promise<Prepared>;
  mint(venue: VenueName, id: Hex, amounts: { amount0Desired: string; amount1Desired: string },
    ticks: { tickLower: number; tickUpper: number }, key: string): Promise<Prepared>;
  approveMint(venue: VenueName, id: Hex, token: Address, amount: string, stage: 'erc20' | 'permit2', key: string): Promise<Prepared>;
  mintAllowances(venue: VenueName, id: Hex): Promise<Array<{ token: string; stage: 'erc20' | 'permit2'; allowance: string; expiration?: string }>>;
  quote(venue: VenueName, id: Hex, tokenIn: Address, amount: string): Promise<Quote>;
  approveSwap(venue: VenueName, id: Hex, tokenIn: Address, amount: string, stage: 'erc20' | 'permit2', key: string): Promise<Prepared>;
  swap(venue: VenueName, id: Hex, tokenIn: Address, amount: string, key: string): Promise<Prepared>;
  execute(id: string): Promise<{ attemptId: string; transactionHash?: Hex }>;
  attempt(id: string): Promise<{ status: string; attempt: Attempt | null }>;
  reconcile(id: string): Promise<{ status: string; reasonCode?: string }>;
}
export class ApiCallError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfter = 60) { super(code); }
}
export const SLIPPAGE_BPS = 100;

export function agentApi(api: Fetcher, secret: string, runId: string): AgentApi {
  const call = async <T>(path: string, body?: unknown, publicRead = false): Promise<T> => {
    const response = await api.fetch(new Request(`https://tideweave-api${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json',
        ...(publicRead ? {} : { 'x-tideweave-agent': secret, 'x-tideweave-run': runId }) },
      body: body === undefined ? undefined : JSON.stringify(body) }));
    const json = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new ApiCallError(json.error ?? `HTTP_${response.status}`, response.status,
      Number(response.headers.get('Retry-After') || 60));
    return json;
  };
  const deadline = () => String(Math.floor(Date.now() / 1000) + 600);
  const assets = (venue: VenueName, id: Hex) => call<Assets & { approvals: ReturnType<AgentApi['mintAllowances']> extends Promise<infer T> ? T : never }>(`/v1/wallets/pairs/${venue}/${id}/assets`);
  const swapBody = (venue: VenueName, pairId: Hex, tokenIn: Address, amountIn: string) => ({ venue, pairId, tokenIn, amountIn, slippageBps: SLIPPAGE_BPS });
  return {
    pool: async (venue, id) => (await call<{ pool: PoolInfo }>(`/v1/pairs/${venue}/${id}?safe=true`, undefined, true)).pool,
    assets,
    close: (venue, tokenId, idempotencyKey) => call(`/v1/wallets/${venue === 'uniswap-v3' ? 'v3' : 'v4/monad'}/positions/actions/prepare`,
      { tokenId, action: 'withdraw', slippageBps: SLIPPAGE_BPS, deadline: deadline(), idempotencyKey }),
    mint: (venue, id, amounts, ticks, idempotencyKey) => call(`/v1/wallets/${venue === 'uniswap-v3' ? 'v3' : 'v4'}/positions/mint/prepare`,
      { ...(venue === 'uniswap-v3' ? { poolAddress: id } : { poolId: id }), ...amounts, ...ticks,
        slippageBps: SLIPPAGE_BPS, deadline: deadline(), idempotencyKey }),
    approveMint: (venue, id, tokenAddress, amount, stage, idempotencyKey) => call(`/v1/wallets/${venue === 'uniswap-v3' ? 'v3' : 'v4'}/approvals/prepare`,
      { ...(venue === 'uniswap-v3' ? { poolAddress: id } : { poolId: id, stage, expiration: deadline() }), tokenAddress, amount, idempotencyKey }),
    mintAllowances: async (venue, id) => (await assets(venue, id)).approvals,
    quote: (venue, id, token, amount) => call('/v1/wallets/swaps/quote', swapBody(venue, id, token, amount)),
    approveSwap: (venue, id, token, amount, stage, idempotencyKey) => call('/v1/wallets/swaps/approvals/prepare',
      { venue, pairId: id, tokenAddress: token, amount, stage, expiration: deadline(), idempotencyKey }),
    swap: async (venue, id, token, amount, idempotencyKey) => {
      const prepared = await call<Prepared & { simulation: { amountOutMinimum: string } }>('/v1/wallets/swaps/prepare',
        { ...swapBody(venue, id, token, amount), idempotencyKey });
      return { ...prepared, minimumOut: prepared.simulation.amountOutMinimum };
    },
    execute: id => call(`/v1/wallets/intents/${id}/execute`, {}),
    attempt: id => call(`/v1/wallets/intents/${id}/attempt`),
    reconcile: id => call(`/v1/wallets/attempts/${id}/reconcile`, {}),
  };
}
