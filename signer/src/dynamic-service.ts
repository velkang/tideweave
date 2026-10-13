import type { Address, Hex } from "viem";
import type { UnsignedTransaction } from "./delegation";

export type DynamicServiceEnv = {
  DYNAMIC_SIGNER_URL: string;
  DYNAMIC_SIGNER_SHARED_SECRET: string;
};

async function callService<T>(env: DynamicServiceEnv, path: string, payload: unknown): Promise<T> {
  const base = new URL(env.DYNAMIC_SIGNER_URL);
  if ((base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") ||
      base.username || base.password || base.search || base.hash) {
    throw new Error("DYNAMIC_SIGNER_URL_INVALID");
  }
  if (!env.DYNAMIC_SIGNER_SHARED_SECRET || env.DYNAMIC_SIGNER_SHARED_SECRET.length < 32) {
    throw new Error("DYNAMIC_SIGNER_SECRET_INVALID");
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.DYNAMIC_SIGNER_SHARED_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const message = `${timestamp}\n${nonce}\n${path}\n${body}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const signature = Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tideweave-timestamp": timestamp,
      "x-tideweave-nonce": nonce,
      "x-tideweave-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`DYNAMIC_SERVICE_${response.status}`);
  return response.json() as Promise<T>;
}

export async function createDynamicWallet(env: DynamicServiceEnv, userId: string): Promise<{
  dynamicWalletId: string;
  address: Address;
}> {
  return callService(env, "/v1/wallets/provision", { userId });
}

export async function signWithDynamic(
  env: DynamicServiceEnv,
  dynamicWalletId: string,
  transaction: UnsignedTransaction,
): Promise<Hex> {
  const result = await callService<{ signedTransaction: Hex }>(env, "/v1/transactions/sign", {
    dynamicWalletId,
    transaction: {
      type: transaction.type,
      // The service signs the authorization itself, after checking it is the one allowed.
      ...(transaction.type === "eip7702" ? { authorizationList: transaction.authorizationList } : {}),
      chainId: transaction.chainId,
      nonce: transaction.nonce,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value?.toString() ?? "0",
      gas: transaction.gas?.toString(),
      maxFeePerGas: transaction.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas?.toString(),
    },
  });
  return result.signedTransaction;
}
