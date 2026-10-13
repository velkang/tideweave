import { encodeAbiParameters, getAddress, pad, toEventSelector, zeroAddress,
  type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, UNISWAP_V4_MONAD, monadV4PoolId } from "@tideweave/chain";
import { monadV4Directory } from "../src/monad-v4-directory";
import type { DirectoryClient } from "../src/pool-discovery";

const currency0 = getAddress("0x1111111111111111111111111111111111111111");
const currency1 = getAddress("0x2222222222222222222222222222222222222222");
const id = monadV4PoolId({ currency0, currency1, fee: 500,
  tickSpacing: 10, hooks: zeroAddress });
const initialize = toEventSelector("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const topic = (address: Address) => pad(address.toLowerCase() as Hex);
const event = (hooks: Address = zeroAddress) => ({ address: UNISWAP_V4_MONAD.poolManager,
  blockNumber: "0x64" as Hex, topics: [initialize, id, topic(currency0), topic(currency1)],
  data: encodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" },
    { type: "uint160" }, { type: "int24" }], [500, 10, hooks, 2n ** 96n, 0]) });

describe("Monad v4 pair directory", () => {
  it("indexes hookless ERC-20 pairs with both token metadata", async () => {
    expect(monadV4Directory.chainId).toBe(MONAD_CHAIN_ID);
    expect(monadV4Directory.creationTopics(currency1)).toEqual([
      [initialize, null, topic(currency1)], [initialize, null, null, topic(currency1)],
    ]);
    const created = monadV4Directory.decode(event());
    expect(created?.tokens).toEqual([currency0, currency1]);
    const client = { getCode: async () => "0x6000" as Hex,
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === UNISWAP_V4_MONAD.stateView) {
          if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 500];
          if (functionName === "getLiquidity") return 900n;
        }
        if (functionName === "decimals") return address === currency0 ? 6 : 24;
        if (functionName === "symbol") return address === currency0 ? "AAA" : "BBB";
        throw new Error("unexpected call");
      },
    } as unknown as DirectoryClient;
    expect(await created?.build(client, 101n, 123)).toMatchObject({
      pool_id: id, currency0, currency1, token0_decimals: 6,
      token1_decimals: 24, liquidity: "900", created_block: 100,
    });
  });

  it("does not index an unreviewed hook", () => {
    expect(monadV4Directory.decode(event(currency0))).toBeNull();
  });

  it("looks a pasted token up through StateView, native MON pools included", async () => {
    const native = { currency0: zeroAddress, currency1, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const client = { readContract: async ({ functionName, args }: { functionName: string; args: Hex[] }) => {
      if (functionName !== "getSlot0") throw new Error("unexpected call");
      return [args[0] === monadV4PoolId(native) ? 2n ** 96n : 0n, 0, 0, 3000];
    } } as unknown as DirectoryClient;
    const found = await monadV4Directory.lookupToken!(client, currency1, 101n);
    expect(found.map(({ key }) => key)).toEqual([monadV4PoolId(native).toLowerCase()]);
    expect(found[0]).toMatchObject({ block: 0n, tokens: [zeroAddress, currency1] });
  });
});

