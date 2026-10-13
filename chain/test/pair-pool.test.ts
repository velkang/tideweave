import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, UNISWAP_V3_MONAD, readMonadV3Pool, readMonadV3Position,
  type MonadV3PoolClient } from "../src";

const pool = getAddress("0x3333333333333333333333333333333333333333");
const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");

function client(options: { canonical?: boolean; initialized?: boolean; liquidity?: bigint;
  factory?: string; positionOwner?: string } = {}): MonadV3PoolClient {
  return {
    async getCode() { return "0x6000"; },
    async readContract({ address, functionName }) {
      if (address === UNISWAP_V3_MONAD.factory && functionName === "getPool") {
        return options.canonical === false ? zeroAddress : pool;
      }
      if (address === UNISWAP_V3_MONAD.nonfungiblePositionManager) {
        if (functionName === "ownerOf") return options.positionOwner ?? token0;
        if (functionName === "positions") return [0n, zeroAddress, token0, token1, 500,
          -100, 100, 75n, 0n, 0n, 3n, 4n];
      }
      if (address === token0 || address === token1) {
        if (functionName === "decimals") return address === token0 ? 6 : 24;
        if (functionName === "symbol") return address === token0 ? "FIRST" : "SECOND";
      }
      if (address === pool) {
        if (functionName === "factory") return options.factory ?? UNISWAP_V3_MONAD.factory;
        if (functionName === "token0") return token0;
        if (functionName === "token1") return token1;
        if (functionName === "fee") return 500;
        if (functionName === "tickSpacing") return 10;
        if (functionName === "slot0") return [options.initialized === false ? 0n : 2n ** 96n, 0, 0, 0, 0, 0, true];
        if (functionName === "liquidity") return options.liquidity ?? 100n;
      }
      throw new Error(`Unexpected ${functionName}`);
    },
  };
}

describe("Monad v3 pair pools", () => {
  it("reads both tokens without assuming a quote token or 18 decimals", async () => {
    const result = await readMonadV3Pool({ client: client(), poolAddress: pool });
    expect(result).toMatchObject({ chainId: MONAD_CHAIN_ID, venue: "uniswap-v3", id: pool,
      token0: { address: token0, symbol: "FIRST", decimals: 6 },
      token1: { address: token1, symbol: "SECOND", decimals: 24 },
      fee: 500, tickSpacing: 10, liquidity: 100n });
  });

  it("rejects a pool not returned by the Monad factory", async () => {
    await expect(readMonadV3Pool({ client: client({ canonical: false }), poolAddress: pool }))
      .rejects.toThrow("POOL_NOT_CANONICAL");
  });

  it("rejects a pool that claims another factory", async () => {
    await expect(readMonadV3Pool({ client: client({ factory: token0 }), poolAddress: pool }))
      .rejects.toThrow("POOL_NOT_CANONICAL");
  });

  it("rejects uninitialized and drained pools", async () => {
    await expect(readMonadV3Pool({ client: client({ initialized: false }), poolAddress: pool }))
      .rejects.toThrow("POOL_NOT_ACTIVE");
    await expect(readMonadV3Pool({ client: client({ liquidity: 0n }), poolAddress: pool }))
      .rejects.toThrow("POOL_NOT_ACTIVE");
  });

  it("lets the directory retain a canonical pool before liquidity arrives", async () => {
    const result = await readMonadV3Pool({ client: client({ initialized: false, liquidity: 0n }),
      poolAddress: pool, requireActive: false });
    expect(result).toMatchObject({ sqrtPriceX96: 0n, liquidity: 0n });
  });

  it("reads an owned position and resolves its canonical Monad pair", async () => {
    const position = await readMonadV3Position({ client: client(), owner: token0,
      tokenId: 7n });
    expect(position).toMatchObject({ tokenId: 7n, tickLower: -100, tickUpper: 100,
      liquidity: 75n, tokensOwed0: 3n, tokensOwed1: 4n,
      pool: { id: pool, token0: { address: token0 }, token1: { address: token1 } } });
    await expect(readMonadV3Position({ client: client({ positionOwner: token1 }),
      owner: token0, tokenId: 7n })).rejects.toThrow("POSITION_NOT_OWNED");
  });
});
