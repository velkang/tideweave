import { MONAD_CHAIN_ID, NADFUN_MONAD, discoverNadPairs, isNadGraduated, readNadPair } from "@tideweave/chain";
import { getAddress, pad, toEventSelector, toFunctionSelector, type Address, type Hex } from "viem";
import { rawCall, word, type RawRpcClient, type RpcLog } from "./directory-scan";
import type { CreatedPool, DirectoryClient, DirectoryRow, ProtocolDirectory } from "./pool-discovery";

// nad.fun pairs are created with every launch but stay empty until the token graduates from
// its bonding curve, so the directory follows the curve's Graduate events, not pair creation.
const GRADUATE = toEventSelector("Graduate(address,address)");
const GET_RESERVES = toFunctionSelector("getReserves()");
const TOTAL_SUPPLY = toFunctionSelector("totalSupply()");
const topic = (address: Address) => pad(address.toLowerCase() as Hex);

async function readState(client: RawRpcClient, pair: Address, block: bigint): Promise<DirectoryRow | null> {
  const [reserves, supply] = await Promise.all([
    rawCall(client, pair, GET_RESERVES, block), rawCall(client, pair, TOTAL_SUPPLY, block),
  ]);
  const reserve0 = reserves && word(reserves, 0);
  const reserve1 = reserves && word(reserves, 1);
  const totalSupply = supply && word(supply, 0);
  if (reserve0 === null || reserve1 === null || totalSupply === null) return null;
  return { reserve0: reserve0.toString(), reserve1: reserve1.toString(), liquidity: totalSupply.toString() };
}

/** The directory row for a canonical WMON pair, or null when the pair or a token is unusable. */
async function buildRow(client: DirectoryClient, pairAddress: Address, block: bigint, updatedAt: number,
  createdBlock: number | null): Promise<DirectoryRow | null> {
  try {
    // Graduation was checked by whoever offered the pair; liquidity can still come and go.
    const pair = await readNadPair({ client, pairAddress, blockNumber: block, requireActive: false });
    return { pair_address: pair.id, token0_address: pair.token0.address,
      token0_symbol: pair.token0.symbol, token0_decimals: pair.token0.decimals,
      token1_address: pair.token1.address, token1_symbol: pair.token1.symbol,
      token1_decimals: pair.token1.decimals, meme_token: pair.memeToken,
      reserve0: pair.reserve0.toString(), reserve1: pair.reserve1.toString(),
      liquidity: pair.totalSupply.toString(), block_number: Number(block), updated_at: updatedAt,
      created_block: createdBlock };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^(?:POOL_|UNSUPPORTED_POOL_TOKEN)/.test(message)) return null;
    throw error;
  }
}

function decode(log: RpcLog): CreatedPool | null {
  if (log.topics[0] !== GRADUATE || log.topics.length < 3 ||
      log.address.toLowerCase() !== NADFUN_MONAD.bondingCurve.toLowerCase()) return null;
  try {
    const token = getAddress(`0x${log.topics[1].slice(26)}`);
    const pair = getAddress(`0x${log.topics[2].slice(26)}`);
    const createdBlock = Number(BigInt(log.blockNumber));
    return { key: pair.toLowerCase(), block: BigInt(log.blockNumber), token, tokens: [token],
      build: (client, block, updatedAt) => buildRow(client, pair, block, updatedAt, createdBlock) };
  } catch {
    return null;
  }
}

/**
 * A pasted token's pair, asked of the factory. A pair whose token has not graduated is left
 * out rather than built and skipped, so it can still be found once it graduates.
 */
async function lookupToken(client: DirectoryClient, token: Address, block: bigint): Promise<CreatedPool[]> {
  if (!(await isNadGraduated(client, getAddress(token), block))) return [];
  const pairs = await discoverNadPairs({ client, token, blockNumber: block });
  return pairs.map((pair) => ({ key: pair.toLowerCase(), block: 0n, token, tokens: [token],
    build: (buildClient, buildBlock, updatedAt) => buildRow(buildClient, pair, buildBlock, updatedAt, null) }));
}

export const monadNadfunDirectory: ProtocolDirectory = {
  name: "monad-nadfun",
  protocol: "nadfun-v2",
  chainId: MONAD_CHAIN_ID,
  liveWindow: 100n,
  lookupWindow: 100n,
  lookupDepth: 1_000n,
  table: "monad_nadfun_pair_directory",
  keyColumn: "pair_address",
  columns: ["pair_address", "token0_address", "token0_symbol", "token0_decimals",
    "token1_address", "token1_symbol", "token1_decimals", "meme_token", "reserve0", "reserve1",
    "liquidity", "block_number", "updated_at", "created_block"],
  stateColumns: ["reserve0", "reserve1", "liquidity", "block_number", "updated_at"],
  usedBy: [],
  emitter: NADFUN_MONAD.bondingCurve,
  creationTopics: (token) => token ? [[GRADUATE, topic(token)]] : [[GRADUATE]],
  decode,
  lookupToken,
  readState: (client, row, block) => readState(client, getAddress(row.pair_address as string), block),
};
