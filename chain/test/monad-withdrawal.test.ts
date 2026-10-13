import { describe, expect, it } from "vitest";
import { decodeFunctionData, maxUint256, zeroAddress } from "viem";
import { buildMonadWithdrawal, erc20TransferAbi, monadWithdrawalPayloadHash } from "../src/monad-withdrawal";

const wallet = "0x1111111111111111111111111111111111111111" as const;
const token = "0x2222222222222222222222222222222222222222" as const;
const recipient = "0x3333333333333333333333333333333333333333" as const;
const nonce = `0x${"ab".repeat(32)}` as const;

describe("Monad withdrawals", () => {
  it("sends an ERC-20 with transfer and binds the payload hash to every key field", () => {
    const withdrawal = buildMonadWithdrawal({ wallet, asset: token, recipient,
      amount: 123n, nonce, expiresAt: 2_000_000_100n });
    expect(withdrawal.to).toBe(token);
    expect(withdrawal.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20TransferAbi, data: withdrawal.data })).toMatchObject({
      functionName: "transfer", args: [recipient, 123n],
    });
    const hash = monadWithdrawalPayloadHash(withdrawal);
    const changes = [
      { amount: 124n },
      { recipient: token },
      { nonce: `0x${"cd".repeat(32)}` as const },
      { wallet: recipient, recipient: wallet },
    ];
    for (const change of changes) {
      const changed = buildMonadWithdrawal({ wallet, asset: token, recipient,
        amount: 123n, nonce, expiresAt: 2_000_000_100n, ...change });
      expect(monadWithdrawalPayloadHash(changed)).not.toBe(hash);
    }
  });

  it("keeps the payload hash when only the expiry differs, so a retry finds its intent", () => {
    const first = buildMonadWithdrawal({ wallet, asset: token, recipient, amount: 1n, nonce, expiresAt: 100n });
    const retry = buildMonadWithdrawal({ wallet, asset: token, recipient, amount: 1n, nonce, expiresAt: 200n });
    expect(monadWithdrawalPayloadHash(retry)).toBe(monadWithdrawalPayloadHash(first));
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
