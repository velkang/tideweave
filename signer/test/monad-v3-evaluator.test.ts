import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { UNISWAP_V3_MONAD, approvalPayloadHash, buildMonadV3Approval } from "@tideweave/chain";
import { evaluateLoadedMainnetIntent, type LoadedMainnetIntent, type MainnetAuditClient,
  type MainnetEvaluation } from "../src/mainnet-evaluator";

const pool = getAddress("0x3333333333333333333333333333333333333333");
const token0 = getAddress("0x1111111111111111111111111111111111111111");
const token1 = getAddress("0x2222222222222222222222222222222222222222");
const owner = getAddress("0x4444444444444444444444444444444444444444");
const approval = buildMonadV3Approval({ tokenAddress: token1, amount: 1_000n });

const loaded: LoadedMainnetIntent = { intentId: "monad-approval-1", kind: "monad_v3_approval",
  status: "pending", expiresAt: 1_100_000, payloadHash: approvalPayloadHash(approval),
  wallet: { address: owner, state: "active" }, transaction: { chainId: 143,
    to: approval.to, data: approval.data, value: 0n },
  approvalPool: { tokenAddress: token1, poolAddress: pool,
    poolTokenAddress: token1, tokenDecimals: 24 } };

const client = {
  getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
  getCode: async () => "0x6000",
  call: async () => ({ data: "0x" }),
  readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (address === UNISWAP_V3_MONAD.factory) return pool;
    if (address === token0 || address === token1) {
      if (functionName === "decimals") return address === token0 ? 6 : 24;
      if (functionName === "symbol") return address === token0 ? "AAA" : "BBB";
    }
    if (functionName === "factory") return UNISWAP_V3_MONAD.factory;
    if (functionName === "token0") return token0;
    if (functionName === "token1") return token1;
    if (functionName === "fee") return 500;
    if (functionName === "tickSpacing") return 10;
    if (functionName === "slot0") return [2n ** 96n, 0];
    if (functionName === "liquidity") return 100n;
    throw new Error("unexpected call");
  },
} as unknown as MainnetAuditClient;

describe("Monad v3 live intent evaluation", () => {
  it.each(["unknown", "monad_unsupported"])(
    "rejects unsupported intent %s before chain reads", async (kind) => {
      const saved: MainnetEvaluation[] = [];
      const result = await evaluateLoadedMainnetIntent({
        loaded: { ...loaded, kind: kind as LoadedMainnetIntent["kind"] },
        client: { ...client, getBlock: async () => { throw new Error("must not read"); } },
        store: { save: async value => { saved.push(value); } }, emergencyStop: false });
      expect(result).toMatchObject({ decision: "rejected", reasonCode: "INTENT_KIND_INVALID" });
      expect(saved).toEqual([result]);
    });

  it("rejects an unsupported chain before chain reads", async () => {
    const result = await evaluateLoadedMainnetIntent({ loaded: { ...loaded,
      transaction: { ...loaded.transaction, chainId: 1 } },
      client: { ...client, getBlock: async () => { throw new Error("must not read"); } },
      store: { save: async () => {} }, emergencyStop: false });
    expect(result).toMatchObject({ decision: "rejected", reasonCode: "CHAIN_NOT_ALLOWED" });
  });

  it("refuses evaluation when a safe block is unavailable", async () => {
    await expect(evaluateLoadedMainnetIntent({ loaded,
      client: { ...client, getBlock: async () => ({ number: null, hash: null }) },
      store: { save: async () => { throw new Error("must not save"); } }, emergencyStop: false }))
      .rejects.toMatchObject({ code: "MONAD_SAFE_BLOCK_UNAVAILABLE", status: 503 });
  });

  it("revalidates a canonical pair and simulated approval before allowing", async () => {
    const saved: MainnetEvaluation[] = [];
    const result = await evaluateLoadedMainnetIntent({ loaded,
      client, store: { save: async (value) => { saved.push(value); } },
      emergencyStop: false, now: () => 1_000_000 });
    expect(result).toMatchObject({ decision: "allowed", reasonCode: "POLICY_ALLOWED" });
    expect(saved).toEqual([result]);
  });

  it("rejects an approval token outside the stored pair", async () => {
    const result = await evaluateLoadedMainnetIntent({ loaded: { ...loaded,
      approvalPool: { ...loaded.approvalPool!, tokenAddress: owner } },
      client, store: { save: async () => {} }, emergencyStop: false,
      now: () => 1_000_000 });
    expect(result).toMatchObject({ decision: "rejected", reasonCode: "APPROVAL_TOKEN_MISMATCH" });
  });
});
