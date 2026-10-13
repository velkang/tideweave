import { getAddress, type Address, type Hex } from "viem";

/**
 * Monad reverts any transaction that takes an EIP-7702-delegated account below 10 MON:
 * https://docs.monad.xyz/developer-essentials/eip-7702
 */
export const MONAD_DELEGATED_RESERVE = 10n * 10n ** 18n;

const DESIGNATOR = /^0xef0100([0-9a-fA-F]{40})$/;

/** The contract an EIP-7702 account delegates to, or null for a plain account. */
export async function readDelegate(
  client: { getCode(input: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined> },
  address: Address,
  blockNumber?: bigint,
): Promise<Address | null> {
  const code = await client.getCode({ address: getAddress(address), blockNumber });
  const match = code ? DESIGNATOR.exec(code) : null;
  return match ? getAddress(`0x${match[1]}`) : null;
}
