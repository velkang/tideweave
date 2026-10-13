import { MONAD_DELEGATED_RESERVE, SIMPLE_7702_ACCOUNT } from "@tideweave/chain";
import { getAddress, serializeTransaction, zeroAddress, type TransactionSerializableEIP7702 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { planDelegation, signedAsBuilt, type UnsignedTransaction } from "../src/delegation";

const other = getAddress("0x9999999999999999999999999999999999999999");

describe("planning a transaction around the wallet's delegation", () => {
  it("authorizes Simple7702Account on a wallet's first nad.fun batch, and keeps the reserve", () => {
    expect(planDelegation("monad_nadfun_add", null)).toEqual({ authorize: SIMPLE_7702_ACCOUNT,
      simulateAs: SIMPLE_7702_ACCOUNT, reserve: MONAD_DELEGATED_RESERVE });
    expect(planDelegation("monad_nadfun_remove", SIMPLE_7702_ACCOUNT)).toEqual({ authorize: null,
      simulateAs: null, reserve: MONAD_DELEGATED_RESERVE });
  });

  it("clears with an authorization to address zero, only when delegated", () => {
    expect(planDelegation("monad_delegation_clear", SIMPLE_7702_ACCOUNT)).toEqual({ authorize: zeroAddress,
      simulateAs: null, reserve: MONAD_DELEGATED_RESERVE });
    expect(planDelegation("monad_delegation_clear", null)).toEqual({ rejected: "NOT_DELEGATED" });
  });

  it("keeps the reserve for any transaction from a delegated wallet, and none for a plain one", () => {
    expect(planDelegation("monad_v3_mint", SIMPLE_7702_ACCOUNT)).toMatchObject({ authorize: null,
      reserve: MONAD_DELEGATED_RESERVE });
    expect(planDelegation("monad_withdrawal", null)).toEqual({ authorize: null, simulateAs: null, reserve: 0n });
  });

  it("refuses a wallet delegated to any other contract", () => {
    expect(planDelegation("monad_nadfun_add", other)).toEqual({ rejected: "DELEGATION_UNEXPECTED" });
    expect(planDelegation("monad_v3_mint", other)).toEqual({ rejected: "DELEGATION_UNEXPECTED" });
  });
});

describe("checking a signed type-4 transaction", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const built: UnsignedTransaction = { type: "eip7702", chainId: 143, nonce: 4, to: account.address, data: "0x1234",
    value: 0n, gas: 300_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n,
    authorizationList: [{ chainId: 143, address: SIMPLE_7702_ACCOUNT, nonce: 5 }] };
  const sign = async (overrides: { authorizer?: typeof account; address?: `0x${string}`; nonce?: number } = {}) => {
    const authorization = await (overrides.authorizer ?? account).signAuthorization({ chainId: 143,
      contractAddress: overrides.address ?? SIMPLE_7702_ACCOUNT, nonce: overrides.nonce ?? 5 });
    const { authorizationList: _unsigned, ...rest } = built;
    return account.signTransaction({ ...rest, authorizationList: [authorization] } as TransactionSerializableEIP7702);
  };

  it("accepts the exact transaction and authorization, both signed by the wallet", async () => {
    expect(await signedAsBuilt(await sign(), built, account.address)).toBe(true);
  });

  it("refuses another delegate, a wrong nonce, or an authorization signed by someone else", async () => {
    expect(await signedAsBuilt(await sign({ address: other }), built, account.address)).toBe(false);
    expect(await signedAsBuilt(await sign({ nonce: 4 }), built, account.address)).toBe(false);
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await signedAsBuilt(await sign({ authorizer: stranger }), built, account.address)).toBe(false);
  });

  it("refuses an EIP-1559 transaction where a type-4 one was asked for", async () => {
    const { authorizationList: _unsigned, ...rest } = built;
    const plain = serializeTransaction({ ...rest, type: "eip1559" });
    expect(await signedAsBuilt(plain, built, account.address)).toBe(false);
  });
});
