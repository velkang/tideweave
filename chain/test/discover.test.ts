import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, NADFUN_MONAD, UNISWAP_V3_MONAD, UNISWAP_V4_MONAD, discoverPairsForToken,
  monadV4PoolId, type MonadV3PoolClient } from "../src";

const token = getAddress("0x9999999999999999999999999999999999999999");
const v3Pool = getAddress("0x3333333333333333333333333333333333333333");
const nadPair = getAddress("0x4444444444444444444444444444444444444444");
const nativeKey = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const usdcKey = { currency0: MONAD_TOKENS.USDC, currency1: token, fee: 500, tickSpacing: 10, hooks: zeroAddress };

function client(calls: string[] = []): MonadV3PoolClient {
  const live = new Set<Hex>([monadV4PoolId(nativeKey), monadV4PoolId(usdcKey)]);
  return {
    async getCode() { return "0x6000"; },
    async readContract({ address, functionName, args }) {
      calls.push(functionName);
      const [a, b, c] = (args ?? []) as [Address, Address, number];
      if (address === UNISWAP_V3_MONAD.factory && functionName === "getPool") {
        const pair = new Set([a, b]);
        return pair.has(token) && pair.has(MONAD_TOKENS.USDC) && c === 3000 ? v3Pool : zeroAddress;
      }
      if (address === UNISWAP_V4_MONAD.stateView && functionName === "getSlot0") {
        return [live.has(a as unknown as Hex) ? 2n ** 96n : 0n, 0, 0, 0];
      }
      if (address === NADFUN_MONAD.factory && functionName === "getPair") {
        return new Set([a, b]).has(MONAD_TOKENS.WMON) ? nadPair : zeroAddress;
      }
      throw new Error(`Unexpected ${functionName}`);
    },
  };
}

describe("finding a token's pools by reading contracts", () => {
  it("finds v3 pools, initialized hookless v4 pools (native MON too) and its nad.fun pair", async () => {
    const found = await discoverPairsForToken({ client: client(), token });
    expect(found.v3).toEqual([v3Pool]);
    expect(found.v4).toEqual(expect.arrayContaining([nativeKey, usdcKey]));
    expect(found.v4).toHaveLength(2);
    expect(found.nadfun).toEqual([nadPair]);
  });

  it("checks every quote token at every standard tier, but never the token against itself", async () => {
    const calls: string[] = [];
    await discoverPairsForToken({ client: client(calls), token: MONAD_TOKENS.USDC });
    const quotes = Object.keys(MONAD_TOKENS).length - 1;
    expect(calls.filter((name) => name === "getPool")).toHaveLength(quotes * 4);
    // Every quote token plus native MON, at four tiers each.
    expect(calls.filter((name) => name === "getSlot0")).toHaveLength((quotes + 1) * 4);
  });

  it("does not look for a nad.fun pair of WMON with itself", async () => {
    const found = await discoverPairsForToken({ client: client(), token: MONAD_TOKENS.WMON });
    expect(found.nadfun).toEqual([]);
  });
});
