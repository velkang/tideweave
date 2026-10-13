import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { MONAD_QUOTE_TOKENS, MONAD_TOKENS, NADFUN_MONAD, UNISWAP_V3_MONAD, UNISWAP_V4_MONAD } from "./monad";
import { monadV4PoolId, type MonadV4PoolKey } from "./monad-v4-pool";
import type { MonadV3PoolClient } from "./pair-pool";

/** Uniswap's standard fee tiers and the tick spacing each one uses. */
export const STANDARD_FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const;

const v3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const nadFactoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address)"]);

export type DiscoveredPairs = { v3: Address[]; v4: MonadV4PoolKey[]; nadfun: Address[] };

const sorted = (a: Address, b: Address): [Address, Address] =>
  a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
const quotesFor = (token: Address) => MONAD_QUOTE_TOKENS.filter((quote) => quote !== token);
const present = <T>(value: T | null): value is T => value !== null;

/** Live Uniswap v3 pools of `token` against each quote token at the standard tiers. */
export async function discoverV3Pools(input: { client: MonadV3PoolClient; token: Address; blockNumber?: bigint }):
  Promise<Address[]> {
  const token = getAddress(input.token);
  const found = await Promise.all(quotesFor(token).flatMap((quote) => STANDARD_FEE_TIERS.map(async ({ fee }) => {
    const pool = await input.client.readContract({ address: UNISWAP_V3_MONAD.factory, abi: v3FactoryAbi,
      functionName: "getPool", args: [token, quote, fee], blockNumber: input.blockNumber });
    return typeof pool === "string" && getAddress(pool) !== zeroAddress ? getAddress(pool) : null;
  })));
  return [...new Set(found.filter(present))];
}

/** Initialized hookless v4 pool keys of `token` against native MON and each quote token. */
export async function discoverV4Keys(input: { client: MonadV3PoolClient; token: Address; blockNumber?: bigint }):
  Promise<MonadV4PoolKey[]> {
  const token = getAddress(input.token);
  const keys = [zeroAddress, ...quotesFor(token)].flatMap((quote) => STANDARD_FEE_TIERS.map(({ fee, tickSpacing }) => {
    const [currency0, currency1] = sorted(quote, token);
    return { currency0, currency1, fee, tickSpacing, hooks: zeroAddress };
  }));
  const found = await Promise.all(keys.map(async (key) => {
    const slot0 = await input.client.readContract({ address: UNISWAP_V4_MONAD.stateView, abi: stateViewAbi,
      functionName: "getSlot0", args: [monadV4PoolId(key)], blockNumber: input.blockNumber });
    return Array.isArray(slot0) && typeof slot0[0] === "bigint" && slot0[0] > 0n ? key : null;
  }));
  return found.filter(present);
}

/** The nad.fun factory's WMON pair for `token`, graduated or not. */
export async function discoverNadPairs(input: { client: MonadV3PoolClient; token: Address; blockNumber?: bigint }):
  Promise<Address[]> {
  const token = getAddress(input.token);
  if (token === MONAD_TOKENS.WMON) return [];
  const pair = await input.client.readContract({ address: NADFUN_MONAD.factory, abi: nadFactoryAbi,
    functionName: "getPair", args: [token, MONAD_TOKENS.WMON], blockNumber: input.blockNumber });
  return typeof pair === "string" && getAddress(pair) !== zeroAddress ? [getAddress(pair)] : [];
}

/**
 * Finds a token's pools by asking each factory directly, so pools created long before the
 * indexer started are found too. Only pools against the quote tokens (and native MON for v4)
 * at standard tiers are found; the results are candidates that each venue's reader still checks.
 */
export async function discoverPairsForToken(input: { client: MonadV3PoolClient; token: Address;
  blockNumber?: bigint }): Promise<DiscoveredPairs> {
  const [v3, v4, nadfun] = await Promise.all([discoverV3Pools(input), discoverV4Keys(input),
    discoverNadPairs(input)]);
  return { v3, v4, nadfun };
}
