import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, NADFUN_MONAD, readNadPair, readNadPosition,
  type MonadV3PoolClient } from "../src";

const pair = getAddress("0x4444444444444444444444444444444444444444");
const meme = getAddress("0x7777777777777777777777777777777777777777");
const owner = getAddress("0x5555555555555555555555555555555555555555");
const wmon = MONAD_TOKENS.WMON;
// WMON sorts below the meme token here, so it is token0.
const [token0, token1] = [wmon, meme];

type Options = { factory?: string; canonical?: boolean; graduated?: boolean | "revert";
  locked?: boolean; totalSupply?: bigint; reserves?: [bigint, bigint]; tokens?: [string, string] };

function client(options: Options = {}): MonadV3PoolClient {
  const [first, second] = options.tokens ?? [token0, token1];
  return {
    async getCode() { return "0x6000"; },
    async readContract({ address, functionName, args }) {
      if (address === NADFUN_MONAD.factory && functionName === "getPair") {
        return options.canonical === false ? zeroAddress : pair;
      }
      if (address === NADFUN_MONAD.router && functionName === "isGraduated") {
        if (options.graduated === "revert") throw new Error("execution reverted");
        expect(args).toEqual([meme]);
        return options.graduated ?? true;
      }
      if (address === pair) {
        if (functionName === "factory") return options.factory ?? NADFUN_MONAD.factory;
        if (functionName === "token0") return first;
        if (functionName === "token1") return second;
        if (functionName === "getReserves") return [...(options.reserves ?? [4_000n, 2_000_000n]), 1];
        if (functionName === "totalSupply") return options.totalSupply ?? 1_000_000n;
        if (functionName === "isLocked") return options.locked ?? false;
        if (functionName === "balanceOf") return 250_000n;
      }
      if (address === wmon || address === meme) {
        if (functionName === "decimals") return 18;
        if (functionName === "symbol") return address === wmon ? "WMON" : "MEME";
      }
      throw new Error(`Unexpected ${functionName}`);
    },
  };
}

describe("nad.fun V2 pairs", () => {
  it("reads a graduated WMON pair with both tokens and live reserves", async () => {
    const result = await readNadPair({ client: client(), pairAddress: pair });
    expect(result).toMatchObject({ chainId: MONAD_CHAIN_ID, venue: "nadfun-v2", id: pair,
      token0: { address: wmon, symbol: "WMON", decimals: 18 },
      token1: { address: meme, symbol: "MEME", decimals: 18 },
      memeToken: meme, reserve0: 4_000n, reserve1: 2_000_000n, totalSupply: 1_000_000n });
  });

  it("rejects a pair from another factory or not returned by the nad.fun factory", async () => {
    await expect(readNadPair({ client: client({ factory: owner }), pairAddress: pair }))
      .rejects.toThrow("POOL_NOT_CANONICAL");
    await expect(readNadPair({ client: client({ canonical: false }), pairAddress: pair }))
      .rejects.toThrow("POOL_NOT_CANONICAL");
  });

  it("rejects a pair with no WMON side", async () => {
    await expect(readNadPair({ client: client({ tokens: [owner, meme] }), pairAddress: pair }))
      .rejects.toThrow("POOL_NOT_CANONICAL");
  });

  it("rejects a token still on its bonding curve, or one the router does not know", async () => {
    await expect(readNadPair({ client: client({ graduated: false }), pairAddress: pair }))
      .rejects.toThrow("POOL_NOT_GRADUATED");
    await expect(readNadPair({ client: client({ graduated: "revert" }), pairAddress: pair }))
      .rejects.toThrow("POOL_NOT_GRADUATED");
  });

  it("rejects a locked pair and one with no liquidity", async () => {
    await expect(readNadPair({ client: client({ locked: true }), pairAddress: pair }))
      .rejects.toThrow("POOL_LOCKED");
    await expect(readNadPair({ client: client({ totalSupply: 0n }), pairAddress: pair }))
      .rejects.toThrow("POOL_NOT_ACTIVE");
    await expect(readNadPair({ client: client({ reserves: [0n, 5n] }), pairAddress: pair }))
      .rejects.toThrow("POOL_NOT_ACTIVE");
  });

  it("lets the directory keep a canonical pair before it graduates", async () => {
    const result = await readNadPair({ client: client({ graduated: false, totalSupply: 0n,
      reserves: [0n, 0n] }), pairAddress: pair, requireActive: false });
    expect(result).toMatchObject({ totalSupply: 0n, reserve0: 0n });
  });

  it("reads the wallet's LP balance and its share of each reserve", async () => {
    const pool = await readNadPair({ client: client(), pairAddress: pair });
    expect(await readNadPosition({ client: client(), pair: pool, owner })).toEqual({
      lpBalance: 250_000n, amount0: 1_000n, amount1: 500_000n,
    });
  });
});
