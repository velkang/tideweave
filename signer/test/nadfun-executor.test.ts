import { MONAD_TOKENS, NADFUN_MONAD, SIMPLE_7702_ACCOUNT, buildNadAdd, nadBatchPayloadHash,
  type MonadNadPair } from "@tideweave/chain";
import { getAddress, keccak256, parseTransaction, type Address, type Hex,
  type TransactionSerializableEIP7702 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { UnsignedTransaction } from "../src/delegation";
import type { LoadedMainnetIntent, MainnetEvaluation } from "../src/mainnet-evaluator";
import { executeMainnetIntent, type MainnetExecutionRpc } from "../src/mainnet-executor";
import type { MainnetSubmission } from "../src/mainnet-submission";

const now = 2_000_000_000_000;
const MON = 10n ** 18n;
const meme = getAddress("0x7777777777777777777777777777777777777777");
const pairAddress = getAddress("0x4444444444444444444444444444444444444444");
const reserves = { reserve0: 4_000n * MON, reserve1: 2_000_000n * MON, totalSupply: 1_000_000n * MON };

function setup(mon: bigint, wrapAmount = 0n) {
  const account = privateKeyToAccount(generatePrivateKey());
  const pair: MonadNadPair = { chainId: 143, venue: "nadfun-v2", id: pairAddress, memeToken: meme,
    token0: { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18 },
    token1: { address: meme, symbol: "MEME", decimals: 18 }, ...reserves };
  const add = buildNadAdd({ pair, wallet: account.address, amount0Desired: 10n * MON, amount1Desired: 5_000n * MON,
    slippageBps: 100, lpBefore: 0n, wrapAmount });
  const intent: LoadedMainnetIntent = {
    intentId: "monad_nadfun_add_1", kind: "monad_nadfun_add", status: "pending", expiresAt: now + 60_000,
    payloadHash: nadBatchPayloadHash(add), wallet: { address: account.address, state: "active" },
    transaction: { chainId: 143, to: account.address, data: add.data, value: 0n },
    custody: { walletId: "wallet-1", dynamicWalletId: "dynamic-1", address: account.address },
    monadNadfun: { action: "add", calldata: add.data, slippageBps: 100, amount0Desired: 10n * MON,
      amount1Desired: 5_000n * MON, wrapAmount, lpBefore: 0n,
      pair: { address: pairAddress, token0: MONAD_TOKENS.WMON, token1: meme, token0Decimals: 18, token1Decimals: 18,
        memeToken: meme, ...reserves } },
  };
  const estimates: unknown[] = [];
  const broadcast: Hex[] = [];
  const submissions: MainnetSubmission[] = [];
  const evaluations: MainnetEvaluation[] = [];
  const rpc = {
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getCode: async ({ address }: { address: Address }) => address === account.address ? undefined : "0x6000",
    getBalance: async () => mon,
    call: async () => ({}),
    simulateContract: async () => { throw new Error("not used"); },
    getTransactionCount: async () => 3,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
    estimateGas: async (input: unknown) => { estimates.push(input); return 200_000n; },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      broadcast.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: Address[] }) => {
      if (address === NADFUN_MONAD.factory) return pairAddress;
      if (address === NADFUN_MONAD.router) return true;
      if (functionName === "balanceOf") return address === pairAddress ? 0n : 1_000_000n * MON;
      if (address === pairAddress) {
        return ({ factory: NADFUN_MONAD.factory, token0: MONAD_TOKENS.WMON, token1: meme,
          getReserves: [reserves.reserve0, reserves.reserve1, 1], totalSupply: reserves.totalSupply,
          isLocked: false } as Record<string, unknown>)[functionName];
      }
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return address === meme ? "MEME" : "WMON";
      throw new Error(`Unexpected ${functionName} ${args}`);
    },
  } as unknown as MainnetExecutionRpc;
  // Stands in for the Dynamic service: signs the authorization it is asked for, then the transaction.
  const signTransaction = async (_id: string, transaction: UnsignedTransaction) => {
    if (transaction.type !== "eip7702") throw new Error("expected a type-4 transaction");
    const [asked] = transaction.authorizationList;
    const authorization = await account.signAuthorization({ chainId: asked.chainId,
      contractAddress: asked.address, nonce: asked.nonce });
    return account.signTransaction({ ...transaction, authorizationList: [authorization] } as
      TransactionSerializableEIP7702);
  };
  const run = () => executeMainnetIntent({
    intentId: intent.intentId,
    evaluationStore: { load: async () => intent, save: async (value) => { evaluations.push(value); } },
    reservationStore: { reserve: async () => true, release: async () => undefined },
    submissionStore: { commit: async (input: MainnetSubmission) => { submissions.push(input); return true; },
      loadReservation: async () => ({ intentId: intent.intentId, walletId: "wallet-1", nonce: 3,
        leaseExpiresAt: now + 30_000, intentStatus: "pending", intentExpiresAt: now + 60_000 }) } as never,
    rpc, signTransaction, emergencyStop: false, now: () => now,
  });
  return { account, add, run, estimates, broadcast, submissions, evaluations };
}

describe("executing a wallet's first nad.fun deposit", () => {
  it("delegates in the same type-4 transaction, with the authorization at nonce + 1", async () => {
    const { account, run, estimates, evaluations } = setup(50n * MON);
    const result = await run();
    expect(evaluations[0]).toMatchObject({ decision: "allowed" });
    const [override] = (estimates[0] as { stateOverride: Array<{ address: string; code: string }> }).stateOverride;
    expect(override.address).toBe(account.address);
    expect(override.code.toLowerCase()).toBe(`0xef0100${SIMPLE_7702_ACCOUNT.slice(2).toLowerCase()}`);
    expect(result.nonce).toBe(3);
  });

  it("signs exactly the batch as type-4, budgeting the authorization's gas", async () => {
    const { account, add, run, broadcast, submissions } = setup(50n * MON);
    const result = await run();
    expect(broadcast).toHaveLength(1);
    const parsed = parseTransaction(broadcast[0]);
    expect(parsed).toMatchObject({ type: "eip7702", chainId: 143, nonce: 3, data: add.data,
      // (200,000 estimated + 25,000 for the authorization) with 20% headroom.
      gas: 270_000n });
    expect(parsed.to?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(parsed.value ?? 0n).toBe(0n);
    expect(parsed.authorizationList).toHaveLength(1);
    expect(parsed.authorizationList?.[0]).toMatchObject({ chainId: 143, nonce: 4 });
    expect(parsed.authorizationList?.[0].address.toLowerCase()).toBe(SIMPLE_7702_ACCOUNT.toLowerCase());
    expect(submissions[0].transactionHash).toBe(result.transactionHash);
  });

  it("counts MON the batch wraps into WMON against the reserve", async () => {
    // 15 MON covers gas and the reserve, but not after wrapping 9 MON inside the batch.
    const { run } = setup(15n * MON, 9n * MON);
    await expect(run()).rejects.toMatchObject({ code: "INSUFFICIENT_MON_RESERVE", status: 422 });
    await expect(setup(25n * MON, 9n * MON).run()).resolves.toMatchObject({ status: "submitted" });
  });

  it("refuses when MON would fall below Monad's 10 MON reserve", async () => {
    const { run } = setup(10n * MON);
    await expect(run()).rejects.toMatchObject({ code: "INSUFFICIENT_MON_RESERVE", status: 422 });
  });
});
