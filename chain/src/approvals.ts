import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { MONAD_CHAIN_ID, UNISWAP_V3_MONAD } from "./monad";
import type { ChainReadClient } from "./reads";

const approveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export type Approval<ChainId extends number = typeof MONAD_CHAIN_ID> = {
  chainId: ChainId;
  tokenSymbol: string;
  tokenAddress: Address;
  spender: Address;
  amount: bigint;
  to: Address;
  data: Hex;
  value: 0n;
};

export type ApprovalSimulationClient = ChainReadClient & {
  estimateGas(parameters: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    blockNumber?: bigint;
  }): Promise<bigint>;
};

type ApprovalInput = {
  tokenAddress: Address;
  tokenSymbol?: string;
  amount: bigint;
  spender?: Address;
};

function buildApprovalFor<ChainId extends number>(input: ApprovalInput,
  deployment: { chainId: ChainId; manager: Address }): Approval<ChainId> {
  if (input.amount <= 0n || input.amount > maxUint256) {
    throw new Error("Approval amount is outside uint256 range");
  }
  const tokenAddress = getAddress(input.tokenAddress);
  const spender = input.spender ? getAddress(input.spender) : deployment.manager;
  return {
    chainId: deployment.chainId,
    tokenSymbol: input.tokenSymbol ?? "TOKEN",
    tokenAddress,
    spender,
    amount: input.amount,
    to: tokenAddress,
    data: encodeFunctionData({
      abi: approveAbi,
      functionName: "approve",
      args: [spender, input.amount],
    }),
    value: 0n,
  };
}

export function buildMonadV3Approval(input: Omit<ApprovalInput, "spender">): Approval<typeof MONAD_CHAIN_ID> {
  return buildApprovalFor(input, { chainId: MONAD_CHAIN_ID,
    manager: UNISWAP_V3_MONAD.nonfungiblePositionManager });
}

export function approvalPayloadHash(approval: Approval<number>): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes" },
      ],
      [
        BigInt(approval.chainId),
        approval.to,
        approval.spender,
        approval.amount,
        approval.data,
      ],
    ),
  );
}

export async function simulateApproval(input: {
  client: ApprovalSimulationClient;
  owner: Address;
  approval: Approval<number>;
  blockNumber: bigint;
}): Promise<{ gasEstimate: string; blockNumber: string }> {
  const simulation = await input.client.simulateContract({
    account: input.owner,
    address: input.approval.to,
    abi: approveAbi,
    functionName: "approve",
    args: [input.approval.spender, input.approval.amount],
    blockNumber: input.blockNumber,
  });
  if (simulation.result !== true) {
    throw new Error("Approval simulation did not return true");
  }
  const gasEstimate = await input.client.estimateGas({
    account: input.owner,
    to: input.approval.to,
    data: input.approval.data,
    value: 0n,
    blockNumber: input.blockNumber,
  });
  return {
    gasEstimate: gasEstimate.toString(),
    blockNumber: input.blockNumber.toString(),
  };
}
