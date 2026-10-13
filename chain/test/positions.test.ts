import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  MONAD_TOKENS,
  UNISWAP_V3_MONAD,
  buildMonadV3Mint,
  mintPayloadHash,
  simulateMint,
  type ApprovalSimulationClient,
} from "../src";

const owner = "0x1111111111111111111111111111111111111111" as const;
const mintAbi = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

// A verified Monad WBTC/USDC pool fixture.
const btcPool = {
  id: "0x3333333333333333333333333333333333333333" as const,
  chainId: 143 as const, venue: "uniswap-v3" as const,
  sqrtPriceX96: 2n ** 96n, liquidity: 1000n, tick: 0,
  token0: { address: MONAD_TOKENS.WBTC, symbol: "WBTC", decimals: 8 },
  token1: { address: MONAD_TOKENS.USDC, symbol: "USDC", decimals: 6 },
  fee: 100,
  tickSpacing: 1,
};

describe("v3 position actions", () => {
  it("builds a mint with bounded slippage and exact recipient", () => {
    const mint = buildMonadV3Mint({
      pool: btcPool,
      recipient: owner,
      tickLower: -100,
      tickUpper: 100,
      amount0Desired: 100_000_000n,
      amount1Desired: 10_000_000n,
      slippageBps: 100,
      deadline: 2_000_000_000n,
    });
    const decoded = decodeFunctionData({ abi: mintAbi, data: mint.data });
    const parameters = decoded.args[0];

    expect(mint.to).toBe(UNISWAP_V3_MONAD.nonfungiblePositionManager);
    expect(mint.value).toBe(0n);
    expect(mint.amount0Min).toBe(99_000_000n);
    expect(mint.amount1Min).toBe(9_900_000n);
    expect(parameters).toMatchObject({
      token0: MONAD_TOKENS.WBTC,
      token1: MONAD_TOKENS.USDC,
      fee: 100,
      recipient: owner,
    });
    expect(mintPayloadHash(mint)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("builds a generic mint for a selected pool regardless of token ordering", () => {
    const generic = buildMonadV3Mint({
      pool: {
        ...btcPool, id: "0x3333333333333333333333333333333333333333",
        token0: { address: MONAD_TOKENS.USDC, symbol: "USDC", decimals: 6 },
        token1: { address: "0x2222222222222222222222222222222222222222", symbol: "MEME", decimals: 18 },
        fee: 500,
        tickSpacing: 10,
      },
      recipient: owner,
      tickLower: -100,
      tickUpper: 100,
      amount0Desired: 1_000_000n,
      amount1Desired: 1_000_000_000_000_000n,
      slippageBps: 100,
      deadline: 2_000_000_000n,
    });
    expect(generic.token0).toBe(MONAD_TOKENS.USDC);
    expect(generic.token1).toBe("0x2222222222222222222222222222222222222222");
    expect(generic.amount0Min).toBe(990_000n);
  });

  it("rejects invalid ranges, empty amounts, and excessive slippage", () => {
    const base = {
      pool: btcPool,
      recipient: owner,
      tickLower: -100,
      tickUpper: 100,
      amount0Desired: 1n,
      amount1Desired: 1n,
      slippageBps: 100,
      deadline: 1n,
    };
    expect(() => buildMonadV3Mint({ ...base, tickLower: 100 })).toThrow();
    expect(() => buildMonadV3Mint({ ...base, amount1Desired: 0n })).toThrow();
    expect(() => buildMonadV3Mint({ ...base, slippageBps: 501 })).toThrow();
  });

  it("returns decoded simulated mint output and gas", async () => {
    const client = {
      simulateContract: async () => ({ result: [12n, 34n, 56n, 78n] }),
      estimateGas: async () => 250_000n,
    } as unknown as ApprovalSimulationClient;
    const mint = buildMonadV3Mint({
      pool: btcPool,
      recipient: owner,
      tickLower: -10,
      tickUpper: 10,
      amount0Desired: 100n,
      amount1Desired: 200n,
      slippageBps: 0,
      deadline: 2_000_000_000n,
    });

    await expect(
      simulateMint({ client, owner, mint, blockNumber: 99n }),
    ).resolves.toEqual({
      blockNumber: "99",
      gasEstimate: "250000",
      tokenId: "12",
      liquidity: "34",
      amount0: "56",
      amount1: "78",
    });
  });

});

