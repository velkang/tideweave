import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID, MONAD_TOKENS } from "./monad";

// Turning native MON into WMON and back. Pools on v3 and nad.fun hold WMON, so a swap from or to native MON
// through them runs a wrap or unwrap as its own step.

export const wmonAbi = parseAbi(["function deposit() payable", "function withdraw(uint256 amount)"]);

export type WrapAction = "wrap" | "unwrap";

export type MonadWrap = {
  chainId: typeof MONAD_CHAIN_ID;
  action: WrapAction;
  amount: bigint;
  to: Address;
  data: Hex;
  value: bigint;
};

/** A wrap sends `amount` MON to WMON.deposit; an unwrap burns `amount` WMON with WMON.withdraw. */
export function buildWrap(input: { action: WrapAction; amount: bigint }): MonadWrap {
  if (input.amount <= 0n || (input.action !== "wrap" && input.action !== "unwrap")) throw new Error("INVALID_WRAP");
  const data = input.action === "wrap"
    ? encodeFunctionData({ abi: wmonAbi, functionName: "deposit" })
    : encodeFunctionData({ abi: wmonAbi, functionName: "withdraw", args: [input.amount] });
  return { chainId: MONAD_CHAIN_ID, action: input.action, amount: input.amount, to: MONAD_TOKENS.WMON, data,
    value: input.action === "wrap" ? input.amount : 0n };
}

export function wrapPayloadHash(wrap: MonadWrap): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint8" }, { type: "uint256" }, { type: "address" }, { type: "bytes" }, { type: "uint256" }],
    [BigInt(wrap.chainId), wrap.action === "wrap" ? 0 : 1, wrap.amount, wrap.to, wrap.data, wrap.value]));
}
