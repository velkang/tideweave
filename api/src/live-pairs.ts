import { parseAbi, type Address, type Hex } from "viem";
import { UNISWAP_V4_MONAD, isAlmostEmpty, readMonUsd, type MonadV3PoolClient } from "@tideweave/chain";
import type { PairListItem } from "./pairs";

// The directory stores a pool's state only when its liquidity appears or disappears, so a listed
// page is re-read from the chain before it is shown, and almost-empty pairs are left out.

const v3Abi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
const nadAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
  "function totalSupply() view returns (uint256)",
]);

const MON_PRICE_TTL_MS = 60_000;
let monPrice: { usd: number; at: number } | null = null;

/** The MON price, cached briefly per Worker instance; null when it cannot be read. */
export async function cachedMonUsd(client: MonadV3PoolClient, now: number): Promise<number | null> {
  if (monPrice && now - monPrice.at < MON_PRICE_TTL_MS) return monPrice.usd;
  try {
    monPrice = { usd: await readMonUsd(client), at: now };
    return monPrice.usd;
  } catch (error) {
    console.warn("MON price unavailable; MON pairs are not judged for depth", error);
    return null;
  }
}

const read = (client: MonadV3PoolClient, call: { address: Address; abi: readonly unknown[]; functionName: string;
  args?: readonly unknown[] }) => client.readContract(call as never).catch(() => null);

/** One pair's current state; the stored state is kept for any part that cannot be read. */
async function liveState(client: MonadV3PoolClient, item: PairListItem): Promise<PairListItem> {
  if (item.venue === "nadfun-v2") {
    const [reserves, supply] = await Promise.all([
      read(client, { address: item.id as Address, abi: nadAbi, functionName: "getReserves" }),
      read(client, { address: item.id as Address, abi: nadAbi, functionName: "totalSupply" }),
    ]);
    if (!Array.isArray(reserves) || typeof supply !== "bigint") return item;
    return { ...item, reserve0: String(reserves[0]), reserve1: String(reserves[1]), liquidity: supply.toString() };
  }
  const [slot0, liquidity] = await Promise.all(item.venue === "uniswap-v4"
    ? [read(client, { address: UNISWAP_V4_MONAD.stateView, abi: stateViewAbi, functionName: "getSlot0",
      args: [item.id as Hex] }),
    read(client, { address: UNISWAP_V4_MONAD.stateView, abi: stateViewAbi, functionName: "getLiquidity",
      args: [item.id as Hex] })]
    : [read(client, { address: item.id as Address, abi: v3Abi, functionName: "slot0" }),
      read(client, { address: item.id as Address, abi: v3Abi, functionName: "liquidity" })]);
  if (!Array.isArray(slot0) || typeof liquidity !== "bigint") return item;
  return { ...item, sqrtPriceX96: String(slot0[0]), tick: Number(slot0[1]), liquidity: liquidity.toString() };
}

/** The pairs re-read from the chain, without those a few dollars could move 2%. */
export async function liveListedPairs(client: MonadV3PoolClient, items: PairListItem[],
  price: () => Promise<number | null>) {
  if (items.length === 0) return [];
  const [monUsd, live] = await Promise.all([price(), Promise.all(items.map((item) => liveState(client, item)))]);
  return live.filter((item) => !isAlmostEmpty(item, monUsd));
}
