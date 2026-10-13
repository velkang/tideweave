import { encodeAbiParameters, getAddress, pad, toEventSelector, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, UNISWAP_V3_MONAD } from "@tideweave/chain";
import { monadV3Directory } from "../src/monad-v3-directory";
import type { DirectoryClient } from "../src/pool-discovery";

const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");
const pool = getAddress("0x3333333333333333333333333333333333333333");
const topic = (address: Address) => pad(address.toLowerCase() as Hex);

describe("Monad v3 pair directory", () => {
  it("indexes both sides of an active canonical pair with independent decimals", async () => {
    expect(monadV3Directory.chainId).toBe(MONAD_CHAIN_ID);
    expect(monadV3Directory.creationTopics(token1)).toEqual([
      [toEventSelector("PoolCreated(address,address,uint24,int24,address)"), topic(token1)],
      [toEventSelector("PoolCreated(address,address,uint24,int24,address)"), null, topic(token1)],
    ]);
    const created = monadV3Directory.decode({ address: UNISWAP_V3_MONAD.factory,
      blockNumber: "0x64", topics: [toEventSelector("PoolCreated(address,address,uint24,int24,address)"),
        topic(token0), topic(token1), pad("0x1f4")],
      data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [10, pool]) });
    expect(created?.tokens).toEqual([token0, token1]);
    const client = {
      getCode: async () => "0x6000" as Hex,
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (functionName === "getPool") return pool;
        if (functionName === "factory") return UNISWAP_V3_MONAD.factory;
        if (functionName === "token0") return token0;
        if (functionName === "token1") return token1;
        if (functionName === "fee") return 500;
        if (functionName === "tickSpacing") return 10;
        if (functionName === "slot0") return [2n ** 96n, 7];
        if (functionName === "liquidity") return 900n;
        if (functionName === "decimals") return address === token0 ? 6 : 24;
        if (functionName === "symbol") return address === token0 ? "AAA" : "BBB";
        throw new Error("unexpected call");
      },
    } as unknown as DirectoryClient;
    const row = await created?.build(client, 101n, 123);
    expect(row).toMatchObject({ pool_address: pool, token0_address: token0, token1_address: token1,
      token0_decimals: 6, token1_decimals: 24, liquidity: "900", created_block: 100 });
  });

  it("looks a pasted token up through the factory at every quote token and tier", async () => {
    const pools = new Set<string>();
    const client = { readContract: async ({ functionName, args }: { functionName: string; args: Address[] }) => {
      if (functionName !== "getPool") throw new Error("unexpected call");
      return args[1] === MONAD_TOKENS.USDC && Number(args[2]) === 3000 ? pool : zeroAddress;
    } } as unknown as DirectoryClient;
    const found = await monadV3Directory.lookupToken!(client, token1, 101n);
    for (const created of found) pools.add(created.key);
    expect([...pools]).toEqual([pool.toLowerCase()]);
    expect(found[0]).toMatchObject({ block: 0n, tokens: [token1] });
  });
});

