import { getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { UNISWAP_V4_MONAD, buildMonadV4Approval, buildMonadV4Mint,
  buildMonadV4PositionAction, monadV4ApprovalPayloadHash, monadV4MintPayloadHash,
  monadV4PositionActionPayloadHash,
  monadV4PoolId, type MonadV4Pool } from "@tideweave/chain";
import { evaluateLoadedMainnetIntent, type LoadedMainnetIntent,
  type MainnetAuditClient } from "../src/mainnet-evaluator";

const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");
const owner = getAddress("0x4444444444444444444444444444444444444444");
const key = { currency0: token0, currency1: token1, fee: 500,
  tickSpacing: 10, hooks: zeroAddress };
const pool: MonadV4Pool = { ...key, id: monadV4PoolId(key), chainId: 143,
  venue: "uniswap-v4",
  token0: { address: token0, symbol: "A", decimals: 6 },
  token1: { address: token1, symbol: "B", decimals: 24 },
  sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000_000n, lpFee: 500 };
const client = {
  getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
  getCode: async () => "0x6000",
  call: async () => ({ data: "0x" }),
  readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (address === UNISWAP_V4_MONAD.stateView) {
      if (functionName === "getSlot0") return [2n ** 96n, 0, 0, 500];
      if (functionName === "getLiquidity") return 1_000_000_000_000n;
    }
    if (address === UNISWAP_V4_MONAD.permit2 && functionName === "allowance") {
      return [10n ** 25n, 2000, 0];
    }
    if (address === token0 || address === token1) {
      if (functionName === "decimals") return address === token0 ? 6 : 24;
      if (functionName === "symbol") return address === token0 ? "A" : "B";
      if (functionName === "balanceOf" || functionName === "allowance") return 10n ** 25n;
    }
    throw new Error("unexpected read");
  },
} as unknown as MainnetAuditClient;
const evaluate = (loaded: LoadedMainnetIntent) => evaluateLoadedMainnetIntent({ loaded,
  client, store: { save: async () => {} }, emergencyStop: false,
  now: () => 1_000_000 });

describe("Monad v4 live intent evaluation", () => {
  it("rebuilds a Permit2 approval from a live canonical pair", async () => {
    const approval = buildMonadV4Approval({ pool, token: token1,
      stage: "permit2", amount: 1_000n, expiration: 2_000n });
    const loaded: LoadedMainnetIntent = { intentId: "monad-v4-approval-1",
      kind: "monad_v4_approval", status: "pending", expiresAt: 1_100_000,
      payloadHash: monadV4ApprovalPayloadHash(approval),
      wallet: { address: owner, state: "active" },
      transaction: { chainId: 143, to: approval.to, data: approval.data, value: 0n },
      monadV4Approval: { poolId: pool.id, key, token: token1, tokenDecimals: 24,
        stage: "permit2", amount: 1_000n, expiration: 2_000n } };
    expect(await evaluate(loaded)).toMatchObject({ decision: "allowed",
      reasonCode: "POLICY_ALLOWED" });
    expect(await evaluate({ ...loaded, monadV4Approval: {
      ...loaded.monadV4Approval!, tokenDecimals: 18 } })).toMatchObject({
      decision: "rejected", reasonCode: "APPROVAL_TOKEN_MISMATCH" });
  });

  it("rebuilds a mint from its preview snapshot and checks fresh allowances", async () => {
    const mint = buildMonadV4Mint({ pool, recipient: owner,
      tickLower: -100, tickUpper: 100, amount0Desired: 1_000_000_000n,
      amount1Desired: 1_000_000_000_000_000_000_000n,
      slippageBps: 100, deadline: 1_600n });
    const loaded: LoadedMainnetIntent = { intentId: "monad-v4-mint-1",
      kind: "monad_v4_mint", status: "pending", expiresAt: 1_600_000,
      payloadHash: monadV4MintPayloadHash(mint),
      wallet: { address: owner, state: "active" },
      transaction: { chainId: 143, to: mint.to, data: mint.data, value: 0n },
      monadV4Mint: { poolId: pool.id, key,
        token0Decimals: 6, token1Decimals: 24,
        snapshot: { sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick,
          liquidity: pool.liquidity, lpFee: pool.lpFee },
        recipient: owner, tickLower: -100, tickUpper: 100,
        amount0Desired: 1_000_000_000n,
        amount1Desired: 1_000_000_000_000_000_000_000n,
        amount0Max: mint.amount0Max, amount1Max: mint.amount1Max,
        slippageBps: 100, deadline: 1_600n } };
    expect(await evaluate(loaded)).toMatchObject({ decision: "allowed",
      reasonCode: "POLICY_ALLOWED" });
    expect(await evaluate({ ...loaded, monadV4Mint: { ...loaded.monadV4Mint!,
      amount0Max: mint.amount0Max - 1n } })).toMatchObject({
      decision: "rejected", reasonCode: "MINT_BUDGET_MISMATCH" });
  });

  it("keeps a reviewed v4 exit valid when price moves while checking NFT liquidity", async () => {
    const position = { tokenId: 7n, pool, tickLower: -100,
      tickUpper: 100, liquidity: 1_000_000n };
    const action = buildMonadV4PositionAction({ kind: "withdraw", position,
      recipient: owner, slippageBps: 100, deadline: 1_600n });
    const loaded: LoadedMainnetIntent = { intentId: "monad-v4-exit-1",
      kind: "monad_v4_position_withdraw", status: "pending", expiresAt: 1_600_000,
      payloadHash: monadV4PositionActionPayloadHash(action),
      wallet: { address: owner, state: "active" },
      transaction: { chainId: 143, to: action.to, data: action.data, value: 0n },
      monadV4PositionAction: { kind: "withdraw", removeBps: 10_000, poolId: pool.id,
        tokenId: 7n, tickLower: -100, tickUpper: 100, liquidity: 1_000_000n,
        slippageBps: 100, deadline: 1_600n, recipient: owner,
        snapshot: { sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick,
          liquidity: pool.liquidity, lpFee: pool.lpFee } } };
    const changedPriceClient = { ...client,
      readContract: async (args: { address: Address; functionName: string }) => {
        if (args.address === UNISWAP_V4_MONAD.positionManager) {
          if (args.functionName === "ownerOf") return owner;
          if (args.functionName === "getPoolAndPositionInfo") {
            return [key, (((1n << 24n) - 100n) << 8n) | (100n << 32n)];
          }
          if (args.functionName === "getPositionLiquidity") return 1_000_000n;
        }
        if (args.address === UNISWAP_V4_MONAD.stateView &&
            args.functionName === "getSlot0") return [2n ** 96n + 1000n, 1, 0, 500];
        return client.readContract({ ...args, abi: [] });
      },
    } as MainnetAuditClient;
    const result = await evaluateLoadedMainnetIntent({ loaded,
      client: changedPriceClient, store: { save: async () => {} },
      emergencyStop: false, now: () => 1_000_000 });
    expect(result).toMatchObject({ decision: "allowed", reasonCode: "POLICY_ALLOWED" });
    const changedLiquidityClient = { ...changedPriceClient,
      readContract: async (args: { address: Address; functionName: string }) =>
        args.address === UNISWAP_V4_MONAD.positionManager &&
          args.functionName === "getPositionLiquidity" ? 999_999n
          : changedPriceClient.readContract({ ...args, abi: [] }),
    } as MainnetAuditClient;
    expect(await evaluateLoadedMainnetIntent({ loaded,
      client: changedLiquidityClient, store: { save: async () => {} },
      emergencyStop: false, now: () => 1_000_000 })).toMatchObject({
      decision: "rejected", reasonCode: "POSITION_CHANGED" });
  });

  it("rebuilds a v4 partial removal from its stored share and refuses calldata for another share", async () => {
    const position = { tokenId: 7n, pool, tickLower: -100, tickUpper: 100, liquidity: 1_000_000n };
    const action = buildMonadV4PositionAction({ kind: "decrease", removeBps: 2_500, position,
      recipient: owner, slippageBps: 100, deadline: 1_600n });
    const stored = { kind: "decrease" as const, removeBps: 2_500, poolId: pool.id, tokenId: 7n, tickLower: -100,
      tickUpper: 100, liquidity: 1_000_000n, slippageBps: 100, deadline: 1_600n, recipient: owner,
      snapshot: { sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity, lpFee: pool.lpFee } };
    const loaded: LoadedMainnetIntent = { intentId: "monad-v4-decrease-1",
      kind: "monad_v4_position_decrease", status: "pending", expiresAt: 1_600_000,
      payloadHash: monadV4PositionActionPayloadHash(action), wallet: { address: owner, state: "active" },
      transaction: { chainId: 143, to: action.to, data: action.data, value: 0n }, monadV4PositionAction: stored };
    const positionClient = { ...client,
      readContract: async (args: { address: Address; functionName: string }) => {
        if (args.address === UNISWAP_V4_MONAD.positionManager) {
          if (args.functionName === "ownerOf") return owner;
          if (args.functionName === "getPoolAndPositionInfo") return [key, (((1n << 24n) - 100n) << 8n) | (100n << 32n)];
          if (args.functionName === "getPositionLiquidity") return 1_000_000n;
        }
        return client.readContract({ ...args, abi: [] });
      },
    } as MainnetAuditClient;
    const run = (intent: LoadedMainnetIntent) => evaluateLoadedMainnetIntent({ loaded: intent, client: positionClient,
      store: { save: async () => {} }, emergencyStop: false, now: () => 1_000_000 });
    expect(await run(loaded)).toMatchObject({ decision: "allowed", reasonCode: "POLICY_ALLOWED" });
    expect(await run({ ...loaded, monadV4PositionAction: { ...stored, removeBps: 5_000 } }))
      .toMatchObject({ decision: "rejected", reasonCode: "TRANSACTION_MISMATCH" });
  });
});
