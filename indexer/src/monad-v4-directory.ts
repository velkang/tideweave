import { MONAD_CHAIN_ID, UNISWAP_V4_MONAD, discoverV4Keys, monadV4PoolId,
  readMonadV4Pool, type MonadV4PoolKey } from "@tideweave/chain";
import { decodeEventLog, getAddress, pad, parseAbi, toEventSelector, toFunctionSelector,
  zeroAddress, type Address, type Hex } from "viem";
import { rawCall, word, type RawRpcClient, type RpcLog } from "./directory-scan";
import type { CreatedPool, DirectoryClient, DirectoryRow, ProtocolDirectory } from "./pool-discovery";

const initializeEvent = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
])[0];
const INITIALIZE = toEventSelector(initializeEvent);
const GET_SLOT0 = toFunctionSelector("getSlot0(bytes32)");
const GET_LIQUIDITY = toFunctionSelector("getLiquidity(bytes32)");
const topic = (address: Address) => pad(address.toLowerCase() as Hex);

async function readState(client: RawRpcClient, id: Hex, block: bigint): Promise<DirectoryRow | null> {
  const [slot0, liquidity] = await Promise.all([
    rawCall(client, UNISWAP_V4_MONAD.stateView, `${GET_SLOT0}${id.slice(2)}` as Hex, block),
    rawCall(client, UNISWAP_V4_MONAD.stateView, `${GET_LIQUIDITY}${id.slice(2)}` as Hex, block),
  ]);
  const sqrtPrice = slot0 && word(slot0, 0);
  const tick = slot0 && word(slot0, 1);
  const lpFee = slot0 && word(slot0, 3);
  const activeLiquidity = liquidity && word(liquidity, 0);
  if (sqrtPrice === null || tick === null || lpFee === null || activeLiquidity === null) return null;
  return { sqrt_price_x96: sqrtPrice.toString(), tick: Number(BigInt.asIntN(24, tick)),
    liquidity: activeLiquidity.toString(), lp_fee: Number(lpFee) };
}

/** The directory row for a hookless pool, or null when the pool or a token is unusable. */
async function buildRow(client: DirectoryClient, key: MonadV4PoolKey, block: bigint, updatedAt: number,
  createdBlock: number | null): Promise<DirectoryRow | null> {
  try {
    const pool = await readMonadV4Pool({ client, key, blockNumber: block, requireActive: false });
    return { pool_id: pool.id, currency0: pool.currency0, currency1: pool.currency1,
      token0_symbol: pool.token0.symbol, token0_decimals: pool.token0.decimals,
      token1_symbol: pool.token1.symbol, token1_decimals: pool.token1.decimals,
      fee: pool.fee, tick_spacing: pool.tickSpacing, hooks: zeroAddress,
      sqrt_price_x96: pool.sqrtPriceX96.toString(), tick: pool.tick,
      liquidity: pool.liquidity.toString(), lp_fee: pool.lpFee,
      block_number: Number(block), updated_at: updatedAt, created_block: createdBlock };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^(?:V4_POOL_|UNSUPPORTED_POOL_TOKEN)/.test(message)) return null;
    throw error;
  }
}

function decode(log: RpcLog): CreatedPool | null {
  if (log.topics[0] !== INITIALIZE ||
      log.address.toLowerCase() !== UNISWAP_V4_MONAD.poolManager.toLowerCase()) return null;
  try {
    const { args } = decodeEventLog({ abi: [initializeEvent], data: log.data,
      topics: log.topics as [Hex, ...Hex[]] });
    const key: MonadV4PoolKey = { currency0: getAddress(args.currency0),
      currency1: getAddress(args.currency1), fee: args.fee,
      tickSpacing: args.tickSpacing, hooks: getAddress(args.hooks) };
    const id = monadV4PoolId(key);
    if (id.toLowerCase() !== args.id.toLowerCase()) return null;
    const createdBlock = Number(BigInt(log.blockNumber));
    return { key: id.toLowerCase(), block: BigInt(log.blockNumber), token: key.currency0,
      tokens: [key.currency0, key.currency1],
      build: (client, block, updatedAt) => buildRow(client, key, block, updatedAt, createdBlock) };
  } catch {
    return null;
  }
}

/** A pasted token's initialized hookless pools, asked of StateView directly. */
async function lookupToken(client: DirectoryClient, token: Address, block: bigint): Promise<CreatedPool[]> {
  const keys = await discoverV4Keys({ client, token, blockNumber: block });
  return keys.map((key) => ({ key: monadV4PoolId(key).toLowerCase(), block: 0n, token: key.currency0,
    tokens: [key.currency0, key.currency1],
    build: (buildClient, buildBlock, updatedAt) => buildRow(buildClient, key, buildBlock, updatedAt, null) }));
}

export const monadV4Directory: ProtocolDirectory = {
  name: "monad-v4",
  protocol: "uniswap-v4",
  chainId: MONAD_CHAIN_ID,
  liveWindow: 100n,
  lookupWindow: 100n,
  lookupDepth: 1_000n,
  table: "monad_v4_pool_directory",
  keyColumn: "pool_id",
  columns: ["pool_id", "currency0", "currency1", "token0_symbol", "token0_decimals",
    "token1_symbol", "token1_decimals", "fee", "tick_spacing", "hooks",
    "sqrt_price_x96", "tick", "liquidity", "lp_fee", "block_number", "updated_at", "created_block"],
  stateColumns: ["sqrt_price_x96", "tick", "liquidity", "lp_fee", "block_number", "updated_at"],
  usedBy: ["monad_v4_approval_intents", "monad_v4_mint_intents",
    "monad_v4_position_action_intents"]
    .map((table) => ({ table, column: "pool_id" })),
  emitter: UNISWAP_V4_MONAD.poolManager,
  creationTopics: (token) => token
    ? [[INITIALIZE, null, topic(token)], [INITIALIZE, null, null, topic(token)]]
    : [[INITIALIZE]],
  decode,
  lookupToken,
  readState: (client, row, block) => readState(client, row.pool_id as Hex, block),
};
