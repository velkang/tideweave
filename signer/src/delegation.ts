import { MONAD_DELEGATED_RESERVE, SIMPLE_7702_ACCOUNT } from "@tideweave/chain";
import { concat, parseTransaction, recoverTransactionAddress, zeroAddress, type Address, type Hex,
  type TransactionSerializableEIP1559 } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { delegationFor, isNadIntentKind } from "./monad-nadfun-policy";

// Gas charged per EIP-7702 authorization in a type-4 transaction (PER_EMPTY_ACCOUNT_COST).
export const AUTHORIZATION_GAS = 25_000n;

/** An EIP-7702 authorization before the custody service signs it. */
export type UnsignedAuthorization = { chainId: number; address: Address; nonce: number };

/** What the custody service is asked to sign: EIP-1559, or EIP-7702 carrying one authorization. */
export type UnsignedTransaction = TransactionSerializableEIP1559 |
  (Omit<TransactionSerializableEIP1559, "type"> & { type: "eip7702"; authorizationList: [UnsignedAuthorization] });

export type DelegationPlan = {
  /** The contract to authorize in this transaction (address zero clears), or null for none. */
  authorize: Address | null;
  /** Simulate and estimate as if already delegated to this contract. */
  simulateAs: Address | null;
  /** MON that must remain after the transaction: Monad's reserve for a delegated account. */
  reserve: bigint;
};

/**
 * How a transaction for `kind` must handle the wallet's delegation. nad.fun batches need the
 * wallet delegated to Simple7702Account, and authorize it on first use; a clear authorizes
 * address zero. While the wallet is (or becomes) delegated, Monad's 10 MON reserve applies.
 */
export function planDelegation(kind: string, delegate: Address | null): DelegationPlan | { rejected: string } {
  if (delegate !== null && delegate !== SIMPLE_7702_ACCOUNT) return { rejected: "DELEGATION_UNEXPECTED" };
  if (!isNadIntentKind(kind)) {
    return { authorize: null, simulateAs: null, reserve: delegate === null ? 0n : MONAD_DELEGATED_RESERVE };
  }
  const target = delegationFor(kind);
  if (target === zeroAddress) {
    if (delegate === null) return { rejected: "NOT_DELEGATED" };
    return { authorize: zeroAddress, simulateAs: null, reserve: MONAD_DELEGATED_RESERVE };
  }
  return { authorize: delegate === null ? target : null, simulateAs: delegate === null ? target : null,
    reserve: MONAD_DELEGATED_RESERVE };
}

export const delegatedCode = (target: Address): Hex => concat(["0xef0100", target]);

/**
 * True when `signed` is exactly `built`, signed by `wallet`, and any authorization it carries is
 * the one asked for and was also signed by `wallet`.
 */
export async function signedAsBuilt(signed: Hex, built: UnsignedTransaction, wallet: Address): Promise<boolean> {
  // parseTransaction leaves zero-valued fields out, so compare with defaults.
  const parsed = parseTransaction(signed);
  const same = parsed.type === built.type &&
    parsed.chainId === built.chainId &&
    (parsed.nonce ?? 0) === (built.nonce ?? 0) &&
    parsed.to?.toLowerCase() === built.to?.toLowerCase() &&
    (parsed.data ?? "0x").toLowerCase() === (built.data ?? "0x").toLowerCase() &&
    (parsed.value ?? 0n) === (built.value ?? 0n) &&
    (parsed.gas ?? 0n) === (built.gas ?? 0n) &&
    (parsed.maxFeePerGas ?? 0n) === (built.maxFeePerGas ?? 0n) &&
    (parsed.maxPriorityFeePerGas ?? 0n) === (built.maxPriorityFeePerGas ?? 0n) &&
    (parsed.accessList ?? []).length === 0;
  if (!same) return false;
  if (built.type === "eip7702") {
    const carried = parsed.type === "eip7702" ? parsed.authorizationList ?? [] : [];
    const [asked] = built.authorizationList;
    if (carried.length !== 1 || carried[0].chainId !== asked.chainId || carried[0].nonce !== asked.nonce ||
        carried[0].address.toLowerCase() !== asked.address.toLowerCase()) return false;
    const authority = await recoverAuthorizationAddress({ authorization: carried[0] });
    if (authority.toLowerCase() !== wallet.toLowerCase()) return false;
  }
  const signer = await recoverTransactionAddress({ serializedTransaction: signed as never });
  return signer.toLowerCase() === wallet.toLowerCase();
}
