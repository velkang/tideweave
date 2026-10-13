import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  type CreateCustodyWallet,
  ProvisioningError,
  provisionWallet,
  type StoredManagedWallet,
  type WalletProvisioningStore,
} from "../src/provision";

const owner = "0x2222222222222222222222222222222222222222" as Address;

const custodyAddress = "0x3333333333333333333333333333333333333333" as Address;

function dynamicWallet() {
  const keys: string[] = [];
  const createWallet: CreateCustodyWallet = async (idempotencyKey) => {
    keys.push(idempotencyKey);
    return { dynamicWalletId: "dynamic-wallet-1", address: custodyAddress };
  };
  return { keys, createWallet };
}

class MemoryStore implements WalletProvisioningStore {
  ownerAddress: Address | null = owner;
  wallet: StoredManagedWallet | null = null;
  insertCount = 0;

  async getOwnerAddress(): Promise<Address | null> {
    return this.ownerAddress;
  }

  async getWalletByUserId(): Promise<StoredManagedWallet | null> {
    return this.wallet;
  }

  async insertWallet(wallet: StoredManagedWallet): Promise<void> {
    this.insertCount += 1;
    this.wallet = wallet;
  }
}

describe("wallet provisioning", () => {
  it("creates one Dynamic wallet keyed by the user id and is idempotent", async () => {
    const store = new MemoryStore();
    const { keys, createWallet } = dynamicWallet();
    const input = { userId: "user-1", walletId: "wallet-1", now: 1_800_000_000 };

    const first = await provisionWallet(store, createWallet, input);
    const second = await provisionWallet(store, createWallet, input);

    expect(first).toEqual({ walletId: "wallet-1", address: custodyAddress, created: true });
    expect(second).toEqual({ ...first, created: false });
    expect(keys).toEqual(["user-1"]);
    expect(store.insertCount).toBe(1);
    expect(store.wallet).toEqual(expect.objectContaining({
      dynamicWalletId: "dynamic-wallet-1",
      address: custodyAddress,
      ownerAddressAtCreation: owner,
    }));
  });

  it("returns the raced wallet when a concurrent provision inserted first", async () => {
    const store = new MemoryStore();
    const { createWallet } = dynamicWallet();
    const raced = { walletId: "wallet-1", address: custodyAddress, dynamicWalletId: "dynamic-wallet-1",
      userId: "user-1", ownerAddressAtCreation: owner, state: "active" as const, createdAt: 1, updatedAt: 1 };
    let reads = 0;
    store.getWalletByUserId = async () => (reads++ === 0 ? null : raced);
    store.insertWallet = async () => { throw new Error("UNIQUE constraint failed"); };

    await expect(provisionWallet(store, createWallet, { userId: "user-1", walletId: "wallet-1", now: 2 }))
      .resolves.toEqual({ walletId: "wallet-1", address: custodyAddress, created: false });
  });

  it("does not reuse a closed legacy custody wallet", async () => {
    const store = new MemoryStore();
    store.wallet = {
      walletId: "wallet-1", userId: "user-1", ownerAddressAtCreation: owner,
      address: custodyAddress, dynamicWalletId: "", state: "closed",
      createdAt: 1, updatedAt: 1,
    };
    const createWallet = vi.fn();
    await expect(provisionWallet(store, createWallet, { userId: "user-1", walletId: "wallet-1", now: 2 }))
      .rejects.toMatchObject({ code: "LEGACY_WALLET_REQUIRES_MIGRATION" });
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("reports a Dynamic failure without storing anything, and logs Dynamic's reason", async () => {
    const store = new MemoryStore();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(provisionWallet(store, async () => { throw new Error("DYNAMIC_401"); },
      { userId: "user-1", walletId: "wallet-1", now: 1 }))
      .rejects.toMatchObject({ code: "CUSTODY_WALLET_CREATE_FAILED" });
    expect(store.insertCount).toBe(0);
    expect(logged).toHaveBeenCalledWith("Dynamic wallet creation failed", "user-1", "DYNAMIC_401");
    logged.mockRestore();
  });

  it("requires a verified owner before generating a managed wallet", async () => {
    const store = new MemoryStore();
    store.ownerAddress = null;
    const { keys, createWallet } = dynamicWallet();

    await expect(
      provisionWallet(store, createWallet, {
        userId: "user-1",
        walletId: "wallet-1",
        now: 1_800_000_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProvisioningError>>({
        code: "VERIFIED_OWNER_NOT_FOUND",
      }),
    );
    expect(store.insertCount).toBe(0);
    expect(keys).toEqual([]);
  });

  it("does not replace an existing user's wallet", async () => {
    const store = new MemoryStore();
    const { createWallet } = dynamicWallet();
    await provisionWallet(store, createWallet, {
      userId: "user-1",
      walletId: "wallet-1",
      now: 1_800_000_000,
    });

    await expect(
      provisionWallet(store, createWallet, {
        userId: "user-1",
        walletId: "wallet-2",
        now: 1_800_000_001,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProvisioningError>>({
        code: "USER_ALREADY_HAS_WALLET",
      }),
    );
    expect(store.insertCount).toBe(1);
  });
});
