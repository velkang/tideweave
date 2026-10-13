import type { Abi, Address } from "viem";

type ContractCall = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
};

export type ChainReadClient = {
  getBalance(parameters: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  readContract(parameters: ContractCall): Promise<unknown>;
  simulateContract(
    parameters: ContractCall & { account: Address },
  ): Promise<{ result: unknown }>;
};

