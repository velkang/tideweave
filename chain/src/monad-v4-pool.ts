import { encodeAbiParameters, getAddress, keccak256, parseAbi, zeroAddress,
  type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID, NATIVE_MON, UNISWAP_V4_MONAD } from "./monad";
import { readMonadPairToken, type MonadV3PoolClient, type PairPool } from "./pair-pool";

export type MonadV4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type MonadV4Pool = PairPool & MonadV4PoolKey & {
  venue: "uniswap-v4";
  id: Hex;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  lpFee: number;
};

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

/**
 * Monad v4 support accepts only hookless pools. Native MON is allowed as currency0, the only
 * place sorting can put the zero address.
 */
export function monadV4PoolId(input: MonadV4PoolKey): Hex {
  const currency0 = getAddress(input.currency0);
  const currency1 = getAddress(input.currency1);
  if (currency1 === zeroAddress ||
      currency0.toLowerCase() >= currency1.toLowerCase() ||
      getAddress(input.hooks) !== zeroAddress ||
      !Number.isInteger(input.fee) || input.fee < 0 || input.fee >= 1_000_000 ||
      !Number.isInteger(input.tickSpacing) || input.tickSpacing <= 0 ||
      input.tickSpacing > 32767) throw new Error("UNSUPPORTED_V4_POOL_KEY");
  return keccak256(encodeAbiParameters([
    { type: "address" }, { type: "address" }, { type: "uint24" },
    { type: "int24" }, { type: "address" },
  ], [currency0, currency1, input.fee, input.tickSpacing, zeroAddress]));
}

/** Read a pool through the official StateView, which derives its state from Monad PoolManager. */
export async function readMonadV4Pool(input: {
  client: MonadV3PoolClient;
  key: MonadV4PoolKey;
  blockNumber?: bigint;
  requireActive?: boolean;
}): Promise<MonadV4Pool> {
  const { client, blockNumber } = input;
  const id = monadV4PoolId(input.key);
  const key = { ...input.key, currency0: getAddress(input.key.currency0),
    currency1: getAddress(input.key.currency1), hooks: zeroAddress };
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: UNISWAP_V4_MONAD.stateView, abi: stateViewAbi,
      functionName: "getSlot0", args: [id], blockNumber }),
    client.readContract({ address: UNISWAP_V4_MONAD.stateView, abi: stateViewAbi,
      functionName: "getLiquidity", args: [id], blockNumber }),
  ]);
  if (!Array.isArray(slot0) || typeof slot0[0] !== "bigint" ||
      typeof slot0[1] !== "number" || typeof slot0[3] !== "number" ||
      typeof liquidity !== "bigint" || slot0[0] < 0n || liquidity < 0n ||
      (input.requireActive !== false && (slot0[0] <= 0n || liquidity <= 0n)) ||
      slot0[3] < 0 || slot0[3] >= 1_000_000) throw new Error("V4_POOL_NOT_ACTIVE");
  const [token0, token1] = await Promise.all([
    key.currency0 === zeroAddress ? { ...NATIVE_MON }
      : readMonadPairToken(client, key.currency0, blockNumber),
    readMonadPairToken(client, key.currency1, blockNumber),
  ]);
  return { chainId: MONAD_CHAIN_ID, venue: "uniswap-v4", id, ...key,
    token0, token1, sqrtPriceX96: slot0[0], tick: slot0[1],
    liquidity, lpFee: slot0[3] };
}
