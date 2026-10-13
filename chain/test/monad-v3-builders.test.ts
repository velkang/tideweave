import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, UNISWAP_V3_MONAD, buildMonadV3Approval, buildMonadV3Mint,
  buildMonadV3CollectAll, buildMonadV3DecreaseLiquidity, buildMonadV3FullWithdrawal,
  buildMonadV3IncreaseLiquidity,
  positionManagerAbi, type MonadV3Pool } from "../src";

const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");
const owner = getAddress("0x4444444444444444444444444444444444444444");
const pool: MonadV3Pool = { chainId: MONAD_CHAIN_ID, venue: "uniswap-v3",
  id: getAddress("0x3333333333333333333333333333333333333333"),
  token0: { address: token0, symbol: "AAA", decimals: 6 },
  token1: { address: token1, symbol: "BBB", decimals: 24 },
  fee: 500, tickSpacing: 10, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 100n };

describe("Monad v3 transaction builders", () => {
  it("approves either pool token to the Monad position manager", () => {
    for (const tokenAddress of [token0, token1]) {
      const approval = buildMonadV3Approval({ tokenAddress, amount: 123n });
      expect(approval).toMatchObject({ chainId: MONAD_CHAIN_ID, to: tokenAddress,
        spender: UNISWAP_V3_MONAD.nonfungiblePositionManager, amount: 123n, value: 0n });
    }
  });

  it("encodes both token amounts and minima for a Monad mint", () => {
    const mint = buildMonadV3Mint({ pool, recipient: owner, tickLower: -100, tickUpper: 100,
      amount0Desired: 123_000_000n, amount1Desired: 456_000_000_000_000_000_000_000_000n,
      slippageBps: 100, deadline: 1_000n });
    expect(mint).toMatchObject({ chainId: MONAD_CHAIN_ID,
      to: UNISWAP_V3_MONAD.nonfungiblePositionManager, token0, token1,
      amount0Min: 121_770_000n, value: 0n });
    const decoded = decodeFunctionData({ abi: positionManagerAbi, data: mint.data });
    expect(decoded.functionName).toBe("mint");
    expect(decoded.args?.[0]).toMatchObject({ token0, token1,
      amount0Desired: mint.amount0Desired, amount1Desired: mint.amount1Desired,
      amount0Min: mint.amount0Min, amount1Min: mint.amount1Min });
  });

  it("targets Monad for increase, decrease, collect, and full exit", () => {
    const common = { tokenId: 7n, recipient: owner };
    const actions = [
      buildMonadV3IncreaseLiquidity({ ...common, amount0: 100n, amount1: 200n,
        slippageBps: 50, deadline: 1_000n }),
      buildMonadV3DecreaseLiquidity({ ...common, liquidity: 10n, expected0: 10n,
        expected1: 20n, slippageBps: 50, deadline: 1_000n }),
      buildMonadV3CollectAll(common),
      buildMonadV3FullWithdrawal({ ...common, liquidity: 10n, expected0: 10n,
        expected1: 20n, slippageBps: 50, deadline: 1_000n }),
    ];
    for (const action of actions) {
      expect(action).toMatchObject({ chainId: MONAD_CHAIN_ID,
        to: UNISWAP_V3_MONAD.nonfungiblePositionManager, value: 0n, recipient: owner });
    }
  });
});
