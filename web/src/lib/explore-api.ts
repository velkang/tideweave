import { post, request } from "./api-client";

// One pair shape for Uniswap v3, Uniswap v4 and nad.fun, matching the API's Explore routes.

export type Venue = "uniswap-v3" | "uniswap-v4" | "nadfun-v2";
export type PairToken = { address: string; symbol: string; decimals: number };

/** A row of the Explore list. */
export type PairListItem = {
  venue: Venue;
  id: string;
  token0: PairToken;
  token1: PairToken;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  sqrtPriceX96: string | null;
  tick: number | null;
  /** Active liquidity for v3 and v4; LP supply for nad.fun. */
  liquidity: string;
  reserve0: string | null;
  reserve1: string | null;
  memeToken: string | null;
  createdBlock: number | null;
};

/** One pair read live; venue-specific fields are present only for their venue. */
export type PairDetail = {
  venue: Venue;
  id: string;
  token0: PairToken;
  token1: PairToken;
  fee?: number;
  tickSpacing?: number;
  tick?: number;
  sqrtPriceX96?: string;
  liquidity?: string;
  reserve0?: string;
  reserve1?: string;
  totalSupply?: string;
  memeToken?: string;
};

export type Approval = { token: string; stage: "erc20" | "permit2"; spender: string; allowance: string;
  expiration?: string };

export type PairAssets = {
  venue: Venue;
  id: string;
  walletAddress: string;
  token0: PairToken & { balance: string };
  token1: PairToken & { balance: string };
  monBalance: string;
  /** The wallet's EIP-7702 delegate, set once it has used nad.fun. */
  delegate: string | null;
  approvals: Approval[];
};

export type Position = {
  venue: Venue;
  /** NFT token id for v3 and v4; the pair address for nad.fun. */
  id: string;
  pool: PairDetail;
  range: { tickLower: number; tickUpper: number } | null;
  /** Position liquidity for v3 and v4; LP tokens held for nad.fun. */
  liquidity: string;
  /** Whether the price is inside the range, so it earns fees; always true for nad.fun. */
  inRange: boolean;
  /** What the position would return if closed now, before fees. */
  amounts: { amount0: string; amount1: string };
  /** Fees ready to collect; null for nad.fun, whose fees grow the LP, or when they could not be read. */
  fees: { amount0: string; amount1: string } | null;
  valueUsd: number | null;
  feesUsd: number | null;
  /** The transaction that opened it, for v3 and v4. */
  transactionHash: string | null;
};

export type SwapQuote = {
  tokenOut: string;
  amountOut: string;
  amountOutMinimum: string;
  priceImpactBps: number;
  tooMuchImpact: boolean;
  balance: string;
  allowances: Array<{ stage: "erc20" | "permit2"; spender: string; allowance: string; expiration?: string }>;
  approved: boolean;
};
export type SwapRequest = { venue: Venue; pairId: string; tokenIn: string; amountIn: string; slippageBps: number };

export type HeldToken = PairToken & { balance: string; usd: number | null };
/** What the managed wallet holds now; `reserve` is the MON Monad makes a nad.fun-delegated wallet keep. */
export type WalletBalances = {
  address: string;
  delegate: string | null;
  reserve: string;
  mon: { balance: string; usd: number | null };
  tokens: HeldToken[];
  totalUsd: number;
  unpricedAssetCount: number;
};

/** A prepared intent: simulated and stored, waiting to be executed. */
export type Prepared = { intentId: string; status: string; simulation?: Record<string, string> };

const path = (venue: Venue, id: string) => `${venue}/${encodeURIComponent(id)}`;

export const exploreApi = {
  listPairs(query = "", offset = 0) {
    return request<{ pools: PairListItem[]; nextOffset: number | null }>(
      `/v1/pairs?q=${encodeURIComponent(query)}&offset=${offset}`);
  },
  getPairById(id: string) {
    return request<{ pool: PairDetail }>(`/v1/pairs/${encodeURIComponent(id)}`);
  },
  getPair(venue: Venue, id: string) {
    return request<{ pool: PairDetail }>(`/v1/pairs/${path(venue, id)}`);
  },
  getPairAssets(venue: Venue, id: string) {
    return request<PairAssets>(`/v1/wallets/pairs/${path(venue, id)}/assets`);
  },
  getWalletBalances() {
    return request<WalletBalances>("/v1/wallets/balances");
  },
  listPositions(page = 0) {
    return request<{ positions: Position[]; hasMore: boolean }>(`/v1/wallets/positions?page=${page}`);
  },

  prepareV3Approval(body: { poolAddress: string; tokenAddress: string; amount: string; idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/v3/approvals/prepare", body);
  },
  prepareV3Mint(body: { poolAddress: string; amount0Desired: string; amount1Desired: string; tickLower: number;
    tickUpper: number; slippageBps: number; deadline: string; idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/v3/positions/mint/prepare", body);
  },
  prepareV3Action(body: { action: "collect" | "decrease" | "withdraw"; tokenId: string; liquidity?: string;
    slippageBps?: number; deadline?: string; idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/v3/positions/actions/prepare", body);
  },

  prepareV4Approval(body: { poolId: string; tokenAddress: string; stage: "erc20" | "permit2"; amount: string;
    expiration?: string; idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/v4/approvals/prepare", body);
  },
  prepareV4Mint(body: { poolId: string; amount0Desired: string; amount1Desired: string; tickLower: number;
    tickUpper: number; slippageBps: number; deadline: string; idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/v4/positions/mint/prepare", body);
  },
  prepareV4Action(body: { action: "collect" | "decrease" | "withdraw"; tokenId: string; slippageBps: number;
    deadline: string; idempotencyKey: string; /** For a decrease: the share removed, 1 to 9,999 basis points. */
    removeBps?: number }) {
    return post<Prepared>("/v1/wallets/v4/monad/positions/actions/prepare", body);
  },

  prepareNadDeposit(pair: string, body: { amount0Desired: string; amount1Desired: string; slippageBps: number;
    wrapAmount?: string; idempotencyKey: string }) {
    return post<Prepared>(`/v1/wallets/nadfun/${encodeURIComponent(pair)}/deposit/prepare`, body);
  },
  prepareNadWithdraw(pair: string, body: { liquidity?: string; slippageBps: number; idempotencyKey: string }) {
    return post<Prepared>(`/v1/wallets/nadfun/${encodeURIComponent(pair)}/withdraw/prepare`, body);
  },
  prepareDelegationClear(body: { idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/delegation/clear/prepare", body);
  },
  quoteSwap(body: SwapRequest) {
    return post<SwapQuote>("/v1/wallets/swaps/quote", body);
  },
  prepareSwap(body: SwapRequest & { idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/swaps/prepare", body);
  },
  /** Wraps MON into WMON, or unwraps WMON, as a step in a routed swap. */
  prepareWrap(body: { action: "wrap" | "unwrap"; amount: string; idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/wrap/prepare", body);
  },
  prepareSwapApproval(body: { venue: Venue; pairId: string; tokenAddress: string; stage: "erc20" | "permit2";
    amount: string; expiration?: string; idempotencyKey: string }) {
    return post<Prepared>("/v1/wallets/swaps/approvals/prepare", body);
  },
};
