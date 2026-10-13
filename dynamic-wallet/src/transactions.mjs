// What the signing service agrees to sign, and the check that it signed exactly that.
// Only Monad (chain 143) EIP-1559 transactions, or EIP-7702 transactions carrying one
// authorization that delegates the wallet to Simple7702Account or clears its delegation.
import { getAddress, isAddress, isAddressEqual, parseTransaction, recoverTransactionAddress, zeroAddress } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";

export const MONAD_CHAIN_ID = 143;
// eth-infinitism Simple7702Account v0.8 on Monad mainnet; address zero clears a delegation.
export const ALLOWED_DELEGATES = ["0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9", zeroAddress];

const invalid = () => { throw new Error("INVALID_TRANSACTION"); };
const decimal = (text) => {
  if (typeof text !== "string" || !/^(0|[1-9]\d*)$/.test(text)) invalid();
  return BigInt(text);
};

function parseAuthorization(value, transactionNonce) {
  if (!Array.isArray(value) || value.length !== 1) invalid();
  const [authorization] = value;
  // The wallet sends its own type-4 transaction: its nonce is spent first, so the
  // authorization must carry the transaction nonce + 1.
  if (!authorization || authorization.chainId !== MONAD_CHAIN_ID || authorization.nonce !== transactionNonce + 1 ||
      !isAddress(authorization.address) ||
      !ALLOWED_DELEGATES.some((delegate) => isAddressEqual(delegate, authorization.address))) invalid();
  return { chainId: MONAD_CHAIN_ID, address: getAddress(authorization.address), nonce: authorization.nonce };
}

/** Validates a sign request; throws INVALID_TRANSACTION for anything outside the allowed shapes. */
export function parseUnsignedTransaction(value) {
  if (!value || (value.type !== "eip1559" && value.type !== "eip7702") || value.chainId !== MONAD_CHAIN_ID ||
      !Number.isSafeInteger(value.nonce) || value.nonce < 0 || !isAddress(value.to) ||
      typeof value.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data)) invalid();
  const transaction = {
    type: value.type, chainId: MONAD_CHAIN_ID, nonce: value.nonce, to: getAddress(value.to),
    data: value.data, value: decimal(value.value), gas: decimal(value.gas),
    maxFeePerGas: decimal(value.maxFeePerGas), maxPriorityFeePerGas: decimal(value.maxPriorityFeePerGas),
  };
  if (transaction.gas === 0n || transaction.maxFeePerGas < transaction.maxPriorityFeePerGas) invalid();
  if (value.type === "eip1559") {
    if (value.authorizationList !== undefined) invalid();
    return transaction;
  }
  return { ...transaction, authorizationList: [parseAuthorization(value.authorizationList, value.nonce)] };
}

/** Names every field where the signed transaction differs from the request, or an empty list. */
export async function signedMismatches(signedTransaction, transaction, walletAddress) {
  const parsed = parseTransaction(signedTransaction);
  const signer = await recoverTransactionAddress({ serializedTransaction: signedTransaction });
  const checks = [
    ["type", parsed.type !== transaction.type], ["chain", parsed.chainId !== MONAD_CHAIN_ID],
    ["nonce", parsed.nonce !== transaction.nonce],
    ["to", !parsed.to || !isAddressEqual(parsed.to, transaction.to)],
    ["data", (parsed.data ?? "0x") !== transaction.data],
    ["value", (parsed.value ?? 0n) !== transaction.value],
    ["gas", parsed.gas !== transaction.gas],
    ["fee", parsed.maxFeePerGas !== transaction.maxFeePerGas],
    ["priority", parsed.maxPriorityFeePerGas !== transaction.maxPriorityFeePerGas],
    ["signer", !isAddressEqual(signer, walletAddress)],
  ];
  if (transaction.type === "eip7702") {
    const carried = parsed.authorizationList ?? [];
    const [asked] = transaction.authorizationList;
    const matches = carried.length === 1 && carried[0].chainId === asked.chainId && carried[0].nonce === asked.nonce &&
      isAddressEqual(carried[0].address, asked.address);
    const authority = matches ? await recoverAuthorizationAddress({ authorization: carried[0] }) : null;
    checks.push(["authorization", !matches], ["authority", !authority || !isAddressEqual(authority, walletAddress)]);
  }
  return checks.filter(([, failed]) => failed).map(([name]) => name);
}
