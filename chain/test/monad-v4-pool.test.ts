import { Ether, Token } from "@uniswap/sdk-core";
import { Pool } from "@uniswap/v4-sdk";
import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, UNISWAP_V4_MONAD, monadV4PoolId, readMonadV4Pool,
  type MonadV3PoolClient, type MonadV4PoolKey } from "../src";

const currency0 = getAddress("0x1111111111111111111111111111111111111111");
const currency1 = getAddress("0x2222222222222222222222222222222222222222");
const key: MonadV4PoolKey = { currency0, currency1, fee: 500,
  tickSpacing: 10, hooks: zeroAddress };

function client(active = true): MonadV3PoolClient {
  return {
    async getCode() { return "0x6000"; },
    async readContract({ address, functionName }) {
      if (address === UNISWAP_V4_MONAD.stateView) {
        if (functionName === "getSlot0") return [active ? 2n ** 96n : 0n, 0, 0, 500];
        if (functionName === "getLiquidity") return active ? 100n : 0n;
      }
      if (address === currency0 || address === currency1) {
        if (functionName === "decimals") return address === currency0 ? 6 : 24;
        if (functionName === "symbol") return address === currency0 ? "FIRST" : "SECOND";
      }
      throw new Error(`Unexpected ${functionName}`);
    },
  };
}

describe("Monad v4 pair pools", () => {
  it("hashes the pool key like the Uniswap SDK", () => {
    expect(monadV4PoolId(key)).toBe(Pool.getPoolId(
      new Token(MONAD_CHAIN_ID, currency0, 6),
      new Token(MONAD_CHAIN_ID, currency1, 24), 500, 10, zeroAddress));
  });

  it("reads both ERC-20 tokens and live state without a fixed quote token", async () => {
    expect(await readMonadV4Pool({ client: client(), key })).toMatchObject({
      chainId: MONAD_CHAIN_ID, venue: "uniswap-v4", id: monadV4PoolId(key),
      token0: { address: currency0, decimals: 6, symbol: "FIRST" },
      token1: { address: currency1, decimals: 24, symbol: "SECOND" },
      liquidity: 100n, lpFee: 500,
    });
  });

  it("reads a native MON pool, naming MON without reading a contract", async () => {
    const native = { ...key, currency0: zeroAddress };
    expect(monadV4PoolId(native)).toBe(Pool.getPoolId(
      Ether.onChain(MONAD_CHAIN_ID), new Token(MONAD_CHAIN_ID, currency1, 24), 500, 10, zeroAddress));
    expect(await readMonadV4Pool({ client: client(), key: native })).toMatchObject({
      currency0: zeroAddress, token0: { address: zeroAddress, symbol: "MON", decimals: 18 },
      token1: { address: currency1, decimals: 24 },
    });
  });

  it("rejects hooks, a native second currency, unsorted keys and inactive pools", async () => {
    expect(() => monadV4PoolId({ ...key, currency1: zeroAddress })).toThrow("UNSUPPORTED_V4_POOL_KEY");
    expect(() => monadV4PoolId({ ...key, hooks: currency0 })).toThrow("UNSUPPORTED_V4_POOL_KEY");
    expect(() => monadV4PoolId({ ...key, currency0: currency1, currency1: currency0 }))
      .toThrow("UNSUPPORTED_V4_POOL_KEY");
    await expect(readMonadV4Pool({ client: client(false), key }))
      .rejects.toThrow("V4_POOL_NOT_ACTIVE");
  });
});
