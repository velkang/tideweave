import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { MONAD_CHAIN_ID, MONAD_TOKENS, NADFUN_MONAD } from "./monad";
import { readMonadPairToken, type MonadV3PoolClient, type PairPool } from "./pair-pool";

/** A nad.fun V2 pair: constant-product reserves and a fungible LP token, always against WMON. */
export type MonadNadPair = PairPool & {
  venue: "nadfun-v2";
  id: Address;
  /** The launched token; the other side is WMON. */
  memeToken: Address;
  reserve0: bigint;
  reserve1: bigint;
  /** LP tokens in existence, including the 1,000 locked at the dead address. */
  totalSupply: bigint;
};

export const nadPairAbi = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function isLocked() view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to) returns (uint256 liquidity)",
  "function burn(address to) returns (uint256 amount0, uint256 amount1)",
  "function transfer(address to, uint256 value) returns (bool)",
]);
const factoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address)"]);
const routerAbi = parseAbi(["function isGraduated(address token) view returns (bool)"]);

/** The router reverts for tokens it never launched; that is "not graduated", not an error. */
export async function isNadGraduated(client: MonadV3PoolClient, token: Address, blockNumber?: bigint) {
  try {
    return await client.readContract({ address: NADFUN_MONAD.router, abi: routerAbi,
      functionName: "isGraduated", args: [token], blockNumber }) === true;
  } catch {
    return false;
  }
}

/**
 * Reads a nad.fun pair and checks it is the factory's own WMON pair. With requireActive (the
 * default) its token must have graduated, the pair must be unlocked and it must hold liquidity:
 * the pair reverts on mint while its LP supply is zero.
 */
export async function readNadPair(input: {
  client: MonadV3PoolClient;
  pairAddress: Address;
  blockNumber?: bigint;
  requireActive?: boolean;
}): Promise<MonadNadPair> {
  const { client, blockNumber } = input;
  const id = getAddress(input.pairAddress);
  const code = await client.getCode({ address: id, blockNumber });
  if (!code || code === "0x") throw new Error("POOL_NOT_CONTRACT");
  const read = (functionName: "factory" | "token0" | "token1" | "getReserves" | "totalSupply" | "isLocked") =>
    client.readContract({ address: id, abi: nadPairAbi, functionName, blockNumber });
  const [factory, rawToken0, rawToken1, reserves, totalSupply, locked] = await Promise.all([
    read("factory"), read("token0"), read("token1"), read("getReserves"), read("totalSupply"), read("isLocked"),
  ]);
  const token0 = getAddress(rawToken0 as string);
  const token1 = getAddress(rawToken1 as string);
  const memeToken = token0 === MONAD_TOKENS.WMON ? token1 : token1 === MONAD_TOKENS.WMON ? token0 : null;
  if (getAddress(factory as string) !== NADFUN_MONAD.factory || memeToken === null ||
      memeToken === zeroAddress) throw new Error("POOL_NOT_CANONICAL");
  const canonical = await client.readContract({ address: NADFUN_MONAD.factory, abi: factoryAbi,
    functionName: "getPair", args: [token0, token1], blockNumber });
  if (getAddress(canonical as string) !== id) throw new Error("POOL_NOT_CANONICAL");
  if (!Array.isArray(reserves) || typeof reserves[0] !== "bigint" || typeof reserves[1] !== "bigint" ||
      typeof totalSupply !== "bigint" || typeof locked !== "boolean") throw new Error("POOL_STATE_INVALID");
  if (input.requireActive !== false) {
    if (!(await isNadGraduated(client, memeToken, blockNumber))) throw new Error("POOL_NOT_GRADUATED");
    if (locked) throw new Error("POOL_LOCKED");
    if (totalSupply === 0n || reserves[0] === 0n || reserves[1] === 0n) throw new Error("POOL_NOT_ACTIVE");
  }
  const [metadata0, metadata1] = await Promise.all([
    readMonadPairToken(client, token0, blockNumber), readMonadPairToken(client, token1, blockNumber),
  ]);
  return { chainId: MONAD_CHAIN_ID, venue: "nadfun-v2", id, token0: metadata0, token1: metadata1,
    memeToken, reserve0: reserves[0], reserve1: reserves[1], totalSupply };
}

/** The wallet's LP tokens in a pair and the reserves they currently redeem for. */
export async function readNadPosition(input: {
  client: MonadV3PoolClient;
  pair: MonadNadPair;
  owner: Address;
  blockNumber?: bigint;
}): Promise<{ lpBalance: bigint; amount0: bigint; amount1: bigint }> {
  const { pair } = input;
  const lpBalance = await input.client.readContract({ address: pair.id, abi: nadPairAbi,
    functionName: "balanceOf", args: [getAddress(input.owner)], blockNumber: input.blockNumber });
  if (typeof lpBalance !== "bigint") throw new Error("POSITION_READ_FAILED");
  if (pair.totalSupply === 0n) return { lpBalance, amount0: 0n, amount1: 0n };
  return { lpBalance, amount0: lpBalance * pair.reserve0 / pair.totalSupply,
    amount1: lpBalance * pair.reserve1 / pair.totalSupply };
}
