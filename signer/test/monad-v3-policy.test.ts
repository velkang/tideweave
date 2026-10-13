import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, approvalPayloadHash, buildMonadV3Approval, buildMonadV3CollectAll,
  buildMonadV3FullWithdrawal, buildMonadV3Mint, mintPayloadHash, positionActionPayloadHash,
  type MonadV3Pool } from "@tideweave/chain";
import { validateMonadV3Intent, type MonadV3PolicyRequest } from "../src/monad-v3-policy";

const owner = getAddress("0x4444444444444444444444444444444444444444");
const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");
const pool: MonadV3Pool = { chainId: MONAD_CHAIN_ID, venue: "uniswap-v3",
  id: getAddress("0x3333333333333333333333333333333333333333"),
  token0: { address: token0, symbol: "A", decimals: 6 },
  token1: { address: token1, symbol: "B", decimals: 24 },
  fee: 500, tickSpacing: 10, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 100n };
const base = (kind: MonadV3PolicyRequest["intent"]["kind"], to: Address,
  data: `0x${string}`, payloadHash: `0x${string}`): MonadV3PolicyRequest => ({
  now: 1_000_000, emergencyStop: false,
  wallet: { address: owner, state: "active" },
  intent: { kind, status: "pending", expiresAt: 1_100_000, payloadHash },
  transaction: { chainId: MONAD_CHAIN_ID, to, data, value: 0n }, pool,
  simulation: { success: true, blockNumber: 100n, latestBlockNumber: 101n },
});

describe("Monad v3 signer policy", () => {
  it("allows either approved pair token and rejects a different token", () => {
    const approval = buildMonadV3Approval({ tokenAddress: token1, amount: 1_000n });
    const request = base("monad_v3_approval", approval.to, approval.data,
      approvalPayloadHash(approval));
    expect(validateMonadV3Intent(request)).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
    expect(validateMonadV3Intent({ ...request, transaction: { ...request.transaction,
      to: owner } })).toEqual({ allowed: false, reason: "TOKEN_NOT_IN_POOL" });
  });

  it("requires a two-token mint in the selected Monad pool", () => {
    const mint = buildMonadV3Mint({ pool, recipient: owner, tickLower: -100, tickUpper: 100,
      amount0Desired: 1_000n, amount1Desired: 2_000n, slippageBps: 100, deadline: 1_600n });
    const request = { ...base("monad_v3_mint", mint.to, mint.data, mintPayloadHash(mint)),
      mintExpected: { amount0: 1_000n, amount1: 2_000n } };
    expect(validateMonadV3Intent(request).allowed).toBe(true);
    expect(validateMonadV3Intent({ ...request, pool: { ...pool, fee: 3_000 } }))
      .toEqual({ allowed: false, reason: "POOL_OR_RECIPIENT_MISMATCH" });
    expect(validateMonadV3Intent({ ...request, transaction: { ...request.transaction,
      chainId: 1 } })).toEqual({ allowed: false, reason: "CHAIN_NOT_ALLOWED" });
  });

  it("uses fresh consumed amounts for mint slippage when desired maxima exceed the ratio", () => {
    const mint = buildMonadV3Mint({ pool, recipient: owner, tickLower: -100, tickUpper: 100,
      amount0Desired: 1_000n, amount1Desired: 2_000n,
      amount0Min: 400n, amount1Min: 903n, slippageBps: 100, deadline: 1_600n });
    const request = { ...base("monad_v3_mint", mint.to, mint.data, mintPayloadHash(mint)),
      mintExpected: { amount0: 420n, amount1: 950n } };
    expect(validateMonadV3Intent(request).allowed).toBe(true);
    expect(validateMonadV3Intent({ ...request,
      mintExpected: { amount0: 600n, amount1: 950n } }))
      .toEqual({ allowed: false, reason: "AMOUNT_OR_SLIPPAGE_INVALID" });
  });

  it("checks owner and full exit sequence while allowing exits during the emergency stop", () => {
    const action = buildMonadV3FullWithdrawal({ tokenId: 7n, recipient: owner,
      liquidity: 50n, expected0: 100n, expected1: 200n,
      slippageBps: 100, deadline: 1_600n });
    const request = { ...base("monad_v3_position_withdraw", action.to, action.data,
      positionActionPayloadHash(action)), emergencyStop: true,
      position: { tokenId: 7n, owner, liquidity: 50n, expected0: 100n, expected1: 200n } };
    expect(validateMonadV3Intent(request).allowed).toBe(true);
    expect(validateMonadV3Intent({ ...request, position: { ...request.position,
      owner: token0 } })).toEqual({ allowed: false, reason: "POSITION_NOT_OWNED" });
    const collect = buildMonadV3CollectAll({ tokenId: 7n, recipient: owner });
    const collectRequest = { ...base("monad_v3_position_collect", collect.to, collect.data,
      positionActionPayloadHash(collect)), position: request.position };
    expect(validateMonadV3Intent(collectRequest).allowed).toBe(true);
  });

  it("rejects stale simulations and reused intents", () => {
    const approval = buildMonadV3Approval({ tokenAddress: token0, amount: 1n });
    const request = base("monad_v3_approval", approval.to, approval.data,
      approvalPayloadHash(approval));
    expect(validateMonadV3Intent({ ...request, simulation: { success: true,
      blockNumber: 100n, latestBlockNumber: 103n } }))
      .toEqual({ allowed: false, reason: "SIMULATION_STALE" });
    expect(validateMonadV3Intent({ ...request, intent: { ...request.intent,
      status: "submitted" } })).toEqual({ allowed: false, reason: "INTENT_NOT_PENDING" });
  });
});
