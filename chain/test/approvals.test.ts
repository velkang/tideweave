import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  MONAD_CHAIN_ID,
  MONAD_TOKENS,
  UNISWAP_V3_MONAD,
  approvalPayloadHash,
  buildMonadV3Approval,
  simulateApproval,
  type ApprovalSimulationClient,
} from "../src";

const approveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const owner = "0x1111111111111111111111111111111111111111" as const;

describe("approvals", () => {
  it("builds an exact approval to the position manager on Monad", () => {
    const approval = buildMonadV3Approval({ tokenAddress: MONAD_TOKENS.USDC, tokenSymbol: "USDC", amount: 1_500_000n });
    const decoded = decodeFunctionData({ abi: approveAbi, data: approval.data });

    expect(approval).toMatchObject({
      chainId: MONAD_CHAIN_ID,
      tokenAddress: MONAD_TOKENS.USDC,
      to: MONAD_TOKENS.USDC,
      spender: UNISWAP_V3_MONAD.nonfungiblePositionManager,
      amount: 1_500_000n,
      value: 0n,
    });
    expect(decoded.args).toEqual([
      UNISWAP_V3_MONAD.nonfungiblePositionManager,
      1_500_000n,
    ]);
    expect(approvalPayloadHash(approval)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each([0n, -1n])("rejects unsafe approval amount %s", (amount) => {
    expect(() => buildMonadV3Approval({ tokenAddress: MONAD_TOKENS.USDC, amount })).toThrow(
      "Approval amount is outside uint256 range",
    );
  });

  it("simulates at the selected block and estimates gas without sending", async () => {
    const calls: unknown[] = [];
    const client = {
      simulateContract: async (parameters: unknown) => {
        calls.push(parameters);
        return { result: true };
      },
      estimateGas: async (parameters: unknown) => {
        calls.push(parameters);
        return 45_000n;
      },
    } as unknown as ApprovalSimulationClient;
    const approval = buildMonadV3Approval({ tokenAddress: MONAD_TOKENS.WBTC, amount: 10n });

    const result = await simulateApproval({
      client,
      owner,
      approval,
      blockNumber: 99n,
    });

    expect(result).toEqual({ gasEstimate: "45000", blockNumber: "99" });
    expect(calls).toHaveLength(2);
    expect(calls).toEqual([
      expect.objectContaining({ account: owner, blockNumber: 99n }),
      expect.objectContaining({ account: owner, blockNumber: 99n }),
    ]);
  });
});
