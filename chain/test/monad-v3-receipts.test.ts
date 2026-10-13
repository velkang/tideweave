import { encodeEventTopics, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { UNISWAP_V3_MONAD } from "../src/monad";
import { monadV3MintedTokenIds, positionManagerAbi } from "../src/positions";

const owner = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222" as const;

describe("Monad v3 mint receipt", () => {
  it("extracts only a manager NFT minted to the intended wallet", () => {
    const topics = encodeEventTopics({ abi: positionManagerAbi,
      eventName: "Transfer", args: { from: zeroAddress, to: owner, tokenId: 42n } }) as Hex[];
    const logs = [
      { address: other, topics, data: "0x" as const },
      { address: UNISWAP_V3_MONAD.nonfungiblePositionManager, topics, data: "0x" as const },
      { address: UNISWAP_V3_MONAD.nonfungiblePositionManager,
        topics: encodeEventTopics({ abi: positionManagerAbi, eventName: "Transfer",
          args: { from: zeroAddress, to: other, tokenId: 43n } }) as Hex[], data: "0x" as const },
    ];
    expect(monadV3MintedTokenIds(logs, owner)).toEqual([42n]);
  });
});
