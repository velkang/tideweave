import { concat, type Address, type Hex } from "viem";
import { MONAD_DELEGATED_RESERVE, readDelegate } from "@tideweave/chain";

// Gas charged per EIP-7702 authorization in a type-4 transaction (PER_EMPTY_ACCOUNT_COST).
export const AUTHORIZATION_GAS = 25_000n;

type CodeClient = { getCode(input: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined> };

/** The wallet's EIP-7702 delegate at a block, or null for a plain account. */
export const walletDelegate = (client: CodeClient, wallet: Address, blockNumber?: bigint) =>
  readDelegate(client, wallet, blockNumber);

/**
 * MON Monad requires a delegated wallet to keep: any transaction that would take it below this
 * reverts. A wallet that is delegated, or is about to be, keeps it.
 */
export const monReserve = (delegated: boolean) => delegated ? MONAD_DELEGATED_RESERVE : 0n;

/** State override that simulates the wallet as already delegated to `delegate`. */
export const asDelegated = (wallet: Address, delegate: Address) =>
  [{ address: wallet, code: concat(["0xef0100", delegate]) }];

/** MON the wallet must keep beyond a transaction's gas and value: Monad's reserve while delegated. */
export async function walletReserve(client: CodeClient, wallet: Address, blockNumber?: bigint) {
  return monReserve(await walletDelegate(client, wallet, blockNumber) !== null);
}

export const monShortfallError = (kept: bigint) => kept > 0n ? "INSUFFICIENT_MON_RESERVE" : "INSUFFICIENT_MON_FOR_GAS";
