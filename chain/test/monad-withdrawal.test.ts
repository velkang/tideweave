import { describe, expect, it } from "vitest";
import { decodeFunctionData, maxUint256, verifyTypedData, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildMonadWithdrawal, monadWithdrawalDomain, monadWithdrawalMessage,
  monadWithdrawalPayloadHash, monadWithdrawalTypes } from "../src/monad-withdrawal";
import { erc20TransferAbi } from "../src/monad-withdrawal";

const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const recipient = "0x3333333333333333333333333333333333333333";
const nonce = `0x${"ab".repeat(32)}` as const;

describe("Monad withdrawals", () => {
  it("binds owner authorization to an ERC-20 transfer and every key field", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const withdrawal = buildMonadWithdrawal({ wallet, asset: token, recipient,
      amount: 123n, nonce, expiresAt: 2_000_000_100n });
    expect(withdrawal.to).toBe(token);
    expect(withdrawal.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20TransferAbi, data: withdrawal.data })).toMatchObject({
      functionName: "transfer", args: [recipient, 123n],
    });
    const signature = await owner.signTypedData({ domain: monadWithdrawalDomain,
      types: monadWithdrawalTypes, primaryType: "MonadWithdrawal",
      message: monadWithdrawalMessage(withdrawal) });
    expect(await verifyTypedData({ address: owner.address, domain: monadWithdrawalDomain,
      types: monadWithdrawalTypes, primaryType: "MonadWithdrawal",
      message: monadWithdrawalMessage(withdrawal), signature })).toBe(true);
    const changed = buildMonadWithdrawal({ wallet, asset: token, recipient,
      amount: 124n, nonce, expiresAt: 2_000_000_100n });
    expect(await verifyTypedData({ address: owner.address, domain: monadWithdrawalDomain,
      types: monadWithdrawalTypes, primaryType: "MonadWithdrawal",
      message: monadWithdrawalMessage(changed), signature })).toBe(false);
    expect(monadWithdrawalPayloadHash(withdrawal, signature))
      .not.toBe(monadWithdrawalPayloadHash(changed, signature));
  });

  it("sends native MON directly to the recipient", () => {
    const withdrawal = buildMonadWithdrawal({ wallet, asset: zeroAddress, recipient,
      amount: 10n, nonce, expiresAt: 2_000_000_100n });
    expect(withdrawal.to).toBe(recipient);
    expect(withdrawal.data).toBe("0x");
    expect(withdrawal.value).toBe(10n);
  });

  it("rejects a self transfer and invalid amount", () => {
    expect(() => buildMonadWithdrawal({ wallet, asset: token, recipient: wallet,
      amount: 1n, nonce, expiresAt: 2_000_000_100n })).toThrow();
    expect(() => buildMonadWithdrawal({ wallet, asset: token, recipient,
      amount: 0n, nonce, expiresAt: 2_000_000_100n })).toThrow();
    expect(() => buildMonadWithdrawal({ wallet, asset: zeroAddress, recipient,
      amount: maxUint256 + 1n, nonce, expiresAt: 2_000_000_100n })).toThrow();
  });
});
