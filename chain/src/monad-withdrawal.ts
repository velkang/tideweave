import { encodeAbiParameters, encodeFunctionData, parseAbi, getAddress, hashTypedData, keccak256,
  maxUint256,
  zeroAddress, type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID } from "./monad";
export const erc20TransferAbi = parseAbi([
  "function transfer(address recipient, uint256 amount) returns (bool)",
]);



export const monadWithdrawalTypes = {
  MonadWithdrawal: [
    { name: "wallet", type: "address" },
    { name: "asset", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const monadWithdrawalDomain = {
  name: "Tideweave",
  version: "2",
  chainId: MONAD_CHAIN_ID,
  verifyingContract: zeroAddress,
} as const;

export type MonadWithdrawal = {
  chainId: typeof MONAD_CHAIN_ID;
  wallet: Address;
  asset: Address;
  recipient: Address;
  amount: bigint;
  nonce: Hex;
  expiresAt: bigint;
  to: Address;
  data: Hex;
  value: bigint;
};

export function buildMonadWithdrawal(input: {
  wallet: Address;
  asset: Address;
  recipient: Address;
  amount: bigint;
  nonce: Hex;
  expiresAt: bigint;
}): MonadWithdrawal {
  const wallet = getAddress(input.wallet);
  const asset = getAddress(input.asset);
  const recipient = getAddress(input.recipient);
  if (recipient === zeroAddress || recipient === wallet || asset === wallet ||
      input.amount <= 0n || input.amount > maxUint256 ||
      input.expiresAt <= 0n || input.expiresAt > maxUint256 ||
      !/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) {
    throw new Error("Invalid Monad withdrawal");
  }
  const native = asset === zeroAddress;
  return {
    chainId: MONAD_CHAIN_ID,
    wallet, asset, recipient, amount: input.amount, nonce: input.nonce,
    expiresAt: input.expiresAt,
    to: native ? recipient : asset,
    data: native ? "0x" : encodeFunctionData({ abi: erc20TransferAbi,
      functionName: "transfer", args: [recipient, input.amount] }),
    value: native ? input.amount : 0n,
  };
}

export function monadWithdrawalMessage(withdrawal: MonadWithdrawal) {
  return { wallet: withdrawal.wallet, asset: withdrawal.asset,
    recipient: withdrawal.recipient, amount: withdrawal.amount,
    nonce: withdrawal.nonce, expiresAt: withdrawal.expiresAt };
}

export function monadWithdrawalPayloadHash(withdrawal: MonadWithdrawal, signature: Hex): Hex {
  const authorizationHash = hashTypedData({ domain: monadWithdrawalDomain,
    types: monadWithdrawalTypes, primaryType: "MonadWithdrawal",
    message: monadWithdrawalMessage(withdrawal) });
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }, { type: "uint256" },
      { type: "bytes32" }, { type: "bytes" }],
    [withdrawal.to, withdrawal.data, withdrawal.value, authorizationHash, signature],
  ));
}
