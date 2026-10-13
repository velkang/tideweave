export type AuthUser = {
  id: string;
  address?: string;
  ownerAddress?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type ManagedWalletRecord = {
  id: string;
  address: string;
  state: "provisioning" | "active" | "paused" | "withdrawing" | "closed" | "quarantined";
  created_at: number;
  updated_at: number;
};

export class ApiError extends Error {
  constructor(public code: string, public status: number, message?: string, public retryAfter = 0) {
    super(message || code);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      credentials: "include",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Network fetch failed";
    throw new ApiError("NETWORK_ERROR", 0, `Failed to fetch ${path}: ${msg}`);
  }

  if (!res.ok) {
    let errorCode = "UNKNOWN_ERROR";
    let errorMessage: string | undefined;
    try {
      const data = await res.json();
      if (data?.error) errorCode = data.error;
      if (data?.message) errorMessage = data.message;
    } catch {
      // response is not json (e.g. Vite proxy error, 502 Bad Gateway)
      errorCode = res.status >= 500 ? "BACKEND_UNREACHABLE" : `HTTP_${res.status}`;
      errorMessage = `Server returned HTTP ${res.status} (${res.statusText || "unreachable backend"}).`;
    }
    const retryAfter = Number(res.headers.get("Retry-After")) || 60;
    if (res.status === 429) errorMessage = `Too many requests. Try again in ${retryAfter} seconds.`;
    throw new ApiError(errorCode, res.status, errorMessage, res.status === 429 ? retryAfter : 0);
  }

  if (res.status === 204) {
    return null as T;
  }

  return res.json();
}

export const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  async latestAttempt() {
    return request<{ attempt: WalletAttempt | null }>("/v1/wallets/attempts/latest");
  },
  // Auth
  async issueChallenge(address: string) {
    return post<{ challengeId: string; message: string; expiresAt: number }>("/v1/auth/challenge", { address });
  },
  async verifyChallenge(challengeId: string, message: string, signature: string) {
    return post<{ user: AuthUser; sessionExpiresAt: number }>("/v1/auth/verify",
      { challengeId, message, signature });
  },
  async getMe() {
    return request<{ user: AuthUser }>("/v1/me");
  },
  async logout() {
    return request<void>("/v1/auth/logout", { method: "POST" });
  },

  // Managed wallet
  async provisionWallet() {
    return request<ManagedWalletRecord>("/v1/wallets/provision", { method: "POST" });
  },
  async getMyWallet() {
    return request<{ wallet: ManagedWalletRecord }>("/v1/wallets/me");
  },
  async prepareMonadWithdrawal(params: { asset: string; recipient: string;
    amount: string; nonce: string }) {
    return post<{ intentId: string; status: string; gasEstimate: string; feeReserve: string }>(
      "/v1/wallets/monad/withdrawals/prepare", params);
  },

  // Intents
  async executeIntent(intentId: string) {
    return request<{ attemptId: string; intentId: string; status: string; transactionHash: string; nonce: number }>(
      `/v1/wallets/intents/${intentId}/execute`, { method: "POST" });
  },
  async reconcileAttempt(attemptId: string) {
    return request<{ attemptId: string; intentId: string; status: string; reasonCode: string;
      transactionHash: string; blockNumber?: number | null }>(
      `/v1/wallets/attempts/${attemptId}/reconcile`, { method: "POST" });
  },
};

export type WalletAttempt = {
  attemptId: string;
  intentId: string;
  kind: string;
  transactionHash: string;
  status: string;
  failureReason: string | null;
};
