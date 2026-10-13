import { decodeAbiParameters, decodeFunctionData, encodeEventTopics, getAddress, parseAbi,
  zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, UNISWAP_V4_MONAD, buildMonadV4Approval,
  buildMonadV4Mint, buildMonadV4PositionAction, monadV4MintedTokenIds, monadV4PositionActionPayloadHash,
  monadV4MintPayloadHash, monadV4PoolId, readMonadV4Position, v4PositionManagerReadAbi,
  readMonadV4TokenAssets,
  type MonadV3PoolClient, type MonadV4Pool } from "../src";

const currency0 = getAddress("0x1111111111111111111111111111111111111111");
const currency1 = getAddress("0x2222222222222222222222222222222222222222");
const key = { currency0, currency1, fee: 500, tickSpacing: 10,
  hooks: zeroAddress };
const pool: MonadV4Pool = { ...key, id: monadV4PoolId(key),
  chainId: MONAD_CHAIN_ID, venue: "uniswap-v4",
  token0: { address: currency0, symbol: "A", decimals: 6 },
  token1: { address: currency1, symbol: "B", decimals: 24 },
  sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000_000n,
  lpFee: 500 };

describe("Monad v4 transaction builders", () => {
  it("reads both ERC-20 and Permit2 balances at one block", async () => {
    const calls: bigint[] = [];
    const client = { readContract: async ({ functionName, blockNumber }: {
      functionName: string; blockNumber?: bigint }) => {
      calls.push(blockNumber ?? 0n);
      if (functionName === "balanceOf") return 2_000n;
      if (functionName === "allowance") return calls.length === 2
        ? 1_000n : [500n, 1_900_000_000, 0];
      throw new Error("unexpected read");
    } } as unknown as MonadV3PoolClient;
    expect(await readMonadV4TokenAssets({ client, owner: currency0,
      token: currency1, blockNumber: 77n })).toEqual({ balance: 2_000n,
      erc20Allowance: 1_000n, permit2Allowance: 500n,
      permit2Expiration: 1_900_000_000n });
    expect(calls).toEqual([77n, 77n, 77n]);
  });

  it("approves either pool token through the two Permit2 stages", () => {
    const erc20 = buildMonadV4Approval({ pool, token: currency1,
      stage: "erc20", amount: 1_000n });
    expect(erc20).toMatchObject({ chainId: 143, to: currency1, value: 0n });
    expect(decodeFunctionData({ abi: parseAbi([
      "function approve(address,uint256) returns (bool)",
    ]), data: erc20.data })).toMatchObject({ functionName: "approve",
      args: [UNISWAP_V4_MONAD.permit2, 1_000n] });
    const permit2 = buildMonadV4Approval({ pool, token: currency0,
      stage: "permit2", amount: 500n, expiration: 1_900_000_000n });
    expect(permit2.to).toBe(UNISWAP_V4_MONAD.permit2);
    expect(decodeFunctionData({ abi: parseAbi([
      "function approve(address,address,uint160,uint48)",
    ]), data: permit2.data })).toMatchObject({ functionName: "approve",
      args: [currency0, UNISWAP_V4_MONAD.positionManager, 500n, 1_900_000_000] });
  });

  it("builds a two-token position mint on Monad", () => {
    const mint = buildMonadV4Mint({ pool, recipient: currency0,
      tickLower: -100, tickUpper: 100,
      amount0Desired: 1_000_000_000n, amount1Desired: 1_000_000_000_000_000_000_000n,
      slippageBps: 100, deadline: 1_900_000_000n });
    expect(mint).toMatchObject({ chainId: 143, poolId: pool.id,
      to: UNISWAP_V4_MONAD.positionManager, value: 0n, recipient: currency0 });
    expect(mint.amount0Max).toBeGreaterThan(0n);
    expect(mint.amount1Max).toBeGreaterThan(0n);
    expect(mint.amount0Max).toBeLessThanOrEqual(1_000_000_000n);
    expect(mint.amount1Max).toBeLessThanOrEqual(1_000_000_000_000_000_000_000n);
  });

  it("rejects foreign tokens, hooks, and single-sided mint ranges", () => {
    expect(() => buildMonadV4Approval({ pool, token: getAddress(
      "0x3333333333333333333333333333333333333333"),
      stage: "erc20", amount: 1n })).toThrow("TOKEN_NOT_IN_V4_POOL");
    expect(() => buildMonadV4Mint({ pool: { ...pool, hooks: currency0 },
      recipient: currency0, tickLower: -100, tickUpper: 100,
      amount0Desired: 1_000n, amount1Desired: 1_000n,
      slippageBps: 100, deadline: 1_900_000_000n })).toThrow("UNSUPPORTED_V4_POOL_KEY");
    expect(() => buildMonadV4Mint({ pool, recipient: currency0,
      tickLower: 100, tickUpper: 200,
      amount0Desired: 1_000n, amount1Desired: 1_000n,
      slippageBps: 100, deadline: 1_900_000_000n })).toThrow("V4_MINT_REQUIRES_BOTH_TOKENS");
  });

  it("reads an owned v4 NFT and builds collect and full exit actions", async () => {
    const negative100 = (1n << 24n) - 100n;
    const packed = (negative100 << 8n) | (100n << 32n);
    const client = { getCode: async () => "0x6000",
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === UNISWAP_V4_MONAD.positionManager) {
          if (functionName === "ownerOf") return currency0;
          if (functionName === "getPoolAndPositionInfo") return [key, packed];
          if (functionName === "getPositionLiquidity") return 123n;
        }
        if (address === UNISWAP_V4_MONAD.stateView) {
          if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 500];
          if (functionName === "getLiquidity") return 1_000_000n;
        }
        if (functionName === "decimals") return address === currency0 ? 6 : 24;
        if (functionName === "symbol") return address === currency0 ? "A" : "B";
        throw new Error("unexpected call");
      },
    } as unknown as MonadV3PoolClient;
    const position = await readMonadV4Position({ client, tokenId: 9n, owner: currency0 });
    expect(position).toMatchObject({ tokenId: 9n, tickLower: -100,
      tickUpper: 100, liquidity: 123n, pool: { id: pool.id } });
    const common = { position, recipient: currency0, slippageBps: 100,
      deadline: 1_900_000_000n };
    const collect = buildMonadV4PositionAction({ ...common, kind: "collect" });
    const withdraw = buildMonadV4PositionAction({ ...common, kind: "withdraw" });
    expect(collect.to).toBe(UNISWAP_V4_MONAD.positionManager);
    expect(collect.value).toBe(0n);
    expect(withdraw.value).toBe(0n);
    expect(withdraw.data).not.toBe(collect.data);
    await expect(readMonadV4Position({ client, tokenId: 9n, owner: currency1 }))
      .rejects.toThrow("POSITION_NOT_OWNED");
  });

  it("finds only Monad PositionManager NFT mints in a receipt", () => {
    const transfer = (from: Address, to: Address, tokenId: bigint) => ({
      data: "0x" as const, topics: encodeEventTopics({ abi: v4PositionManagerReadAbi,
        eventName: "Transfer", args: { from, to, tokenId } }) as `0x${string}`[],
    });
    expect(monadV4MintedTokenIds([
      { address: UNISWAP_V4_MONAD.positionManager,
        ...transfer(zeroAddress, currency0, 7n) },
      { address: currency1, ...transfer(zeroAddress, currency0, 8n) },
      { address: UNISWAP_V4_MONAD.positionManager,
        ...transfer(currency1, currency0, 9n) },
    ], currency0)).toEqual([7n]);
  });

  it("removes part of a position without burning it, and its share is fixed by the calldata", () => {
    const position = { tokenId: 9n, pool, tickLower: -100, tickUpper: 100, liquidity: 1_000_000n };
    const common = { position, recipient: currency0, slippageBps: 100, deadline: 1_900_000_000n };
    const half = buildMonadV4PositionAction({ ...common, kind: "decrease", removeBps: 5_000 });
    const [unlockData] = decodeFunctionData({ abi: parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline)"]),
      data: half.data }).args;
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], unlockData);
    // DECREASE_LIQUIDITY (0x01) then TAKE_PAIR (0x11) to the caller; no BURN_POSITION (0x03).
    expect(actions).toBe("0x0111");
    const [tokenId, liquidity] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" },
      { type: "uint128" }, { type: "bytes" }], params[0]);
    expect([tokenId, liquidity]).toEqual([9n, 500_000n]);
    expect(half.removeBps).toBe(5_000);
    expect(half.value).toBe(0n);
    const quarter = buildMonadV4PositionAction({ ...common, kind: "decrease", removeBps: 2_500 });
    expect(monadV4PositionActionPayloadHash(quarter)).not.toBe(monadV4PositionActionPayloadHash(half));
    expect(monadV4PositionActionPayloadHash(half)).not.toBe(monadV4PositionActionPayloadHash(
      buildMonadV4PositionAction({ ...common, kind: "withdraw" })));
    for (const removeBps of [0, 10_000, 1.5, undefined]) {
      expect(() => buildMonadV4PositionAction({ ...common, kind: "decrease", removeBps }))
        .toThrow("INVALID_V4_POSITION_ACTION");
    }
  });

  describe("native MON as currency0", () => {
    const nativeKey = { ...key, currency0: zeroAddress };
    const nativePool: MonadV4Pool = { ...pool, ...nativeKey, id: monadV4PoolId(nativeKey),
      token0: { address: zeroAddress, symbol: "MON", decimals: 18 } };
    const mint = () => buildMonadV4Mint({ pool: nativePool, recipient: currency0,
      tickLower: -100, tickUpper: 100, amount0Desired: 10n ** 18n, amount1Desired: 10n ** 24n,
      slippageBps: 100, deadline: 1_900_000_000n });

    it("sends the MON side as value, capped at its slippage maximum", () => {
      const built = mint();
      expect(built.value).toBe(built.amount0Max);
      expect(built.value).toBeGreaterThan(0n);
      expect(built.value).toBeLessThanOrEqual(10n ** 18n);
    });

    it("sends no value for an ERC-20 pair", () => {
      expect(buildMonadV4Mint({ pool, recipient: currency0, tickLower: -100, tickUpper: 100,
        amount0Desired: 1_000_000_000n, amount1Desired: 10n ** 24n, slippageBps: 100,
        deadline: 1_900_000_000n }).value).toBe(0n);
    });

    it("binds the value into the payload hash", () => {
      const built = mint();
      expect(monadV4MintPayloadHash(built)).not.toBe(monadV4MintPayloadHash({ ...built, value: built.value - 1n }));
    });

    it("refuses to approve native MON, which needs no approval", () => {
      expect(() => buildMonadV4Approval({ pool: nativePool, token: zeroAddress, stage: "erc20", amount: 1n }))
        .toThrow("NATIVE_NEEDS_NO_APPROVAL");
    });

    it("exits a native position without sending value", () => {
      const action = buildMonadV4PositionAction({ kind: "withdraw", recipient: currency0, slippageBps: 100,
        deadline: 1_900_000_000n, position: { tokenId: 9n, pool: nativePool, tickLower: -100, tickUpper: 100,
          liquidity: 1_000_000n } });
      expect(action.value).toBe(0n);
    });
  });
});

