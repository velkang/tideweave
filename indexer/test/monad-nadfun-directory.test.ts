import { encodeAbiParameters, getAddress, pad, toEventSelector, toFunctionSelector, zeroAddress,
  type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, NADFUN_MONAD } from "@tideweave/chain";
import { monadNadfunDirectory } from "../src/monad-nadfun-directory";
import type { DirectoryClient } from "../src/pool-discovery";

const meme = getAddress("0x7777777777777777777777777777777777777777");
const pair = getAddress("0x4444444444444444444444444444444444444444");
const graduate = toEventSelector("Graduate(address,address)");
const topic = (address: Address) => pad(address.toLowerCase() as Hex);
const graduation = { address: NADFUN_MONAD.bondingCurve, blockNumber: "0x64" as Hex,
  topics: [graduate, topic(meme), topic(pair)], data: "0x" as Hex };

function client(graduated = true): DirectoryClient {
  return {
    getCode: async () => "0x6000" as Hex,
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (address === NADFUN_MONAD.factory && functionName === "getPair") return pair;
      if (address === NADFUN_MONAD.router && functionName === "isGraduated") return graduated;
      if (address === pair) {
        if (functionName === "factory") return NADFUN_MONAD.factory;
        if (functionName === "token0") return MONAD_TOKENS.WMON;
        if (functionName === "token1") return meme;
        if (functionName === "getReserves") return [5n, 9n, 0];
        if (functionName === "totalSupply") return 7n;
        if (functionName === "isLocked") return false;
      }
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return address === meme ? "MEME" : "WMON";
      throw new Error(`unexpected ${functionName}`);
    },
  } as unknown as DirectoryClient;
}

describe("nad.fun pair directory", () => {
  it("finds pairs as their tokens graduate, optionally for one token", () => {
    expect(monadNadfunDirectory.chainId).toBe(MONAD_CHAIN_ID);
    expect(monadNadfunDirectory.emitter).toBe(NADFUN_MONAD.bondingCurve);
    expect(monadNadfunDirectory.creationTopics()).toEqual([[graduate]]);
    expect(monadNadfunDirectory.creationTopics(meme)).toEqual([[graduate, topic(meme)]]);
  });

  it("stores a graduated pair with its reserves and LP supply", async () => {
    const created = monadNadfunDirectory.decode(graduation);
    expect(created).toMatchObject({ key: pair.toLowerCase(), block: 100n, tokens: [meme] });
    expect(await created?.build(client(), 101n, 123)).toMatchObject({ pair_address: pair,
      token0_address: MONAD_TOKENS.WMON, token1_address: meme, token1_symbol: "MEME",
      meme_token: meme, reserve0: "5", reserve1: "9", liquidity: "7", block_number: 101,
      updated_at: 123, created_block: 100 });
  });

  it("ignores events from anywhere but the bonding curve", () => {
    expect(monadNadfunDirectory.decode({ ...graduation, address: pair })).toBeNull();
    expect(monadNadfunDirectory.decode({ ...graduation, topics: [topic(pair)] })).toBeNull();
  });

  it("looks a pasted token up through the factory, but only once it has graduated", async () => {
    const found = await monadNadfunDirectory.lookupToken!(client(), meme, 101n);
    expect(found.map(({ key }) => key)).toEqual([pair.toLowerCase()]);
    // An ungraduated pair is left out, not built and skipped, so it can be found after graduating.
    expect(await monadNadfunDirectory.lookupToken!(client(false), meme, 101n)).toEqual([]);
  });

  it("refreshes reserves and LP supply with raw calls", async () => {
    const words = (...values: bigint[]) => encodeAbiParameters(values.map(() => ({ type: "uint256" })), values);
    const raw = { request: async ({ params }: { method: string; params: unknown[] }) => {
      const [call] = params as [{ data: Hex }];
      if (call.data === toFunctionSelector("getReserves()")) return words(11n, 13n, 0n);
      if (call.data === toFunctionSelector("totalSupply()")) return words(17n);
      return zeroAddress;
    } };
    expect(await monadNadfunDirectory.readState(raw, { pair_address: pair }, 200n))
      .toEqual({ reserve0: "11", reserve1: "13", liquidity: "17" });
  });
});
