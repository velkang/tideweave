import type { Context } from "hono";
import { parseAbi } from "viem";
import { AuthError } from "./auth";
import type { AppEnvironment } from "./env";

export async function jsonBody(context: Context<AppEnvironment>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AuthError("INVALID_JSON", 400);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("INVALID_REQUEST", 400);
  }
  return value as Record<string, unknown>;
}

export function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
export const erc20ApproveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
