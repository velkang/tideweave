import { readDelegate } from "@tideweave/chain";
import {
  keccak256,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { AUTHORIZATION_GAS, delegatedCode, planDelegation, signedAsBuilt,
  type UnsignedTransaction } from "./delegation";
import {
  evaluateLoadedMainnetIntent,
  type MainnetAuditClient,
  type MainnetEvaluationStore,
} from "./mainnet-evaluator";
import type { ExecutionRehearsalStore } from "./mainnet-rehearsal";
import {
  handoffMainnetSubmission,
  type MainnetSubmissionStore,
} from "./mainnet-submission";

export type MainnetExecutionResult = {
  attemptId: string;
  intentId: string;
  status: "submitted";
  transactionHash: Hex;
  nonce: number;
};

export type MainnetExecutionRpc = MainnetAuditClient & {
  // Required here: v3 swaps, approvals and mints fail revalidation without it.
  getCode(parameters: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getBalance?(input: { address: Address }): Promise<bigint>;
  getTransactionCount(input: {
    address: Address;
    blockTag: "pending";
  }): Promise<number>;
  estimateFeesPerGas(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }>;
  estimateGas(input: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    stateOverride?: Array<{ address: Address; code: Hex }>;
  }): Promise<bigint>;
  sendRawTransaction(input: {
    serializedTransaction: Hex;
  }): Promise<Hex>;
};

export class MainnetExecutionError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function executeMainnetIntent(input: {
  intentId: string;
  evaluationStore: MainnetEvaluationStore;
  reservationStore: Pick<ExecutionRehearsalStore, "reserve" | "release">;
  submissionStore: MainnetSubmissionStore;
  rpc: MainnetExecutionRpc;
  /** Signs with the custody provider (and any EIP-7702 authorization) and returns the serialized transaction. */
  signTransaction: (dynamicWalletId: string, transaction: UnsignedTransaction) => Promise<Hex>;
  emergencyStop: boolean;
  now?: () => number;
}): Promise<MainnetExecutionResult> {
  const now = input.now ?? Date.now;
  const loaded = await input.evaluationStore.load(input.intentId);
  if (!loaded) {
    throw new MainnetExecutionError("MAINNET_INTENT_NOT_FOUND", 404);
  }

  const evaluation = await evaluateLoadedMainnetIntent({
    loaded,
    store: input.evaluationStore,
    client: input.rpc,
    emergencyStop: input.emergencyStop,
    now,
  });
  if (evaluation.decision !== "allowed") {
    throw new MainnetExecutionError(evaluation.reasonCode, 422);
  }
  const custody = loaded.custody;
  if (!custody) {
    throw new MainnetExecutionError("CUSTODY_WALLET_UNAVAILABLE", 500);
  }

  const plan = planDelegation(loaded.kind, await readDelegate(input.rpc, loaded.wallet.address));
  if ("rejected" in plan) throw new MainnetExecutionError(plan.rejected, 422);
  const [nonce, fees, estimatedGas] = await Promise.all([
    input.rpc.getTransactionCount({
      address: loaded.wallet.address,
      blockTag: "pending",
    }),
    input.rpc.estimateFeesPerGas(),
    input.rpc.estimateGas({
      account: loaded.wallet.address,
      to: loaded.transaction.to,
      data: loaded.transaction.data,
      value: loaded.transaction.value,
      ...(plan.simulateAs ? { stateOverride: [{ address: loaded.wallet.address,
        code: delegatedCode(plan.simulateAs) }] } : {}),
    }).then((gas) => gas + (plan.authorize === null ? 0n : AUTHORIZATION_GAS)),
  ]);
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new MainnetExecutionError("PENDING_NONCE_INVALID", 503);
  }
  if (
    fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n ||
    fees.maxPriorityFeePerGas > fees.maxFeePerGas
  ) {
    throw new MainnetExecutionError("FEE_ESTIMATE_INVALID", 503);
  }
  if (estimatedGas <= 0n) {
    throw new MainnetExecutionError("GAS_ESTIMATE_INVALID", 503);
  }
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  if (!input.rpc.getBalance) {
    throw new MainnetExecutionError("MON_BALANCE_UNAVAILABLE", 503);
  }
  const balance = await input.rpc.getBalance({ address: loaded.wallet.address });
  // A delegated wallet must keep Monad's 10 MON reserve, or the transaction reverts. A nad.fun
  // batch can also spend MON inside itself, wrapping it into WMON, beyond the transaction value.
  const spentInside = loaded.monadNadfun?.wrapAmount ?? 0n;
  if (balance < loaded.transaction.value + spentInside + gasLimit * fees.maxFeePerGas + plan.reserve) {
    throw new MainnetExecutionError(plan.reserve > 0n ? "INSUFFICIENT_MON_RESERVE" : "INSUFFICIENT_MON_FOR_GAS", 422);
  }

  const reservedAt = now();
  if (!(await input.reservationStore.reserve({
    intentId: loaded.intentId,
    walletId: custody.walletId,
    nonce,
    now: reservedAt,
    leaseExpiresAt: reservedAt + 30_000,
  }))) {
    throw new MainnetExecutionError("WALLET_EXECUTION_BUSY", 409);
  }

  const base = {
    chainId: loaded.transaction.chainId,
    to: loaded.transaction.to,
    data: loaded.transaction.data,
    value: loaded.transaction.value,
    nonce,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  // The wallet sends its own type-4 transaction, so its nonce is spent before the
  // authorization is checked: the authorization carries the transaction nonce + 1.
  const transaction: UnsignedTransaction = plan.authorize === null
    ? { ...base, type: "eip1559" }
    : { ...base, type: "eip7702", authorizationList: [{ chainId: loaded.transaction.chainId,
      address: plan.authorize, nonce: nonce + 1 }] };

  let signed: Hex;
  try {
    signed = await input.signTransaction(custody.dynamicWalletId, transaction);
    // Never broadcast what we did not build: the remote signature must cover
    // exactly this transaction and come from this wallet.
    if (!(await signedAsBuilt(signed, transaction, custody.address))) {
      throw new Error("SIGNED_TRANSACTION_MISMATCH");
    }
  } catch {
    await input.reservationStore.release({
      intentId: loaded.intentId,
      walletId: custody.walletId,
      nonce,
      now: now(),
    });
    throw new MainnetExecutionError("MAINNET_SIGNING_FAILED", 500);
  }

  const transactionHash = keccak256(signed);
  const attemptId = `mainnet_attempt_${crypto.randomUUID()}`;
  await handoffMainnetSubmission({
    attemptId,
    intentId: loaded.intentId,
    signedNonce: nonce,
    chainId: loaded.transaction.chainId,
    transactionHash,
    store: input.submissionStore,
    now,
  });

  let returnedHash: Hex;
  try {
    returnedHash = await input.rpc.sendRawTransaction({
      serializedTransaction: signed,
    });
  } catch {
    return {
      attemptId,
      intentId: loaded.intentId,
      status: "submitted",
      transactionHash,
      nonce,
    };
  }
  if (returnedHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new MainnetExecutionError("BROADCAST_HASH_MISMATCH", 502);
  }
  return {
    attemptId,
    intentId: loaded.intentId,
    status: "submitted",
    transactionHash,
    nonce,
  };
}
