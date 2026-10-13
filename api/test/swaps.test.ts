import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, UNISWAP_V3_MONAD, swapRouter02Abi, type MonadV3PoolClient } from "@tideweave/chain";
import { hashOpaqueValue, type AuthStore } from "../src/auth";
import { createApp, type Bindings } from "../src/index";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const pool = getAddress("0x3333333333333333333333333333333333333333");
const env = { AUTH_URI: "http://localhost:5173" } as Bindings;
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
// 1 WMON = 0.03 USDC: raw USDC per raw WMON is 3e-14.
const SQRT_PRICE = BigInt(Math.round(Math.sqrt(3e-14) * 2 ** 96));
const ONE_WMON = 10n ** 18n;
// The fair output for 1 WMON after the 0.3% fee is about 29,910 raw USDC.
const FAIR_OUT = 29_900n;

async function setup(options: { quoteOut?: bigint; allowance?: bigint; liquidity?: bigint } = {}) {
  const token = `swap-session-${Math.random()}`;
  const hash = await hashOpaqueValue(token);
  const authStore = { findSessionUser: async (given: string) => given === hash
    ? { id: "user-1", ownerAddress: wallet } : null } as unknown as AuthStore;
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) { let values: unknown[] = []; return {
    bind(...args: unknown[]) { values = args; return this; },
    async first() { if (sql.includes("FROM automation_runs")) return null; return sql.includes("managed_wallets") ? { id: "wallet-1", address: wallet, state: "active" } : null; },
    get sql() { return sql; }, get values() { return values; },
  }; }, async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    writes.push(...statements.map(({ sql, values }) => ({ sql, values }))); return [];
  } } as unknown as D1Database;
  const client = {
    getCode: async () => "0x6000",
    getBlock: async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` }),
    getBalance: async () => 10n ** 20n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n ** 9n }),
    estimateGas: async () => 150_000n,
    call: async ({ to }: { to: Address }) => to === UNISWAP_V3_MONAD.quoterV2
      ? { data: encodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInputSingle",
        result: [options.quoteOut ?? FAIR_OUT, 0n, 0, 0n] }) as Hex } : { data: "0x" as Hex },
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (address === UNISWAP_V3_MONAD.factory) return pool;
      if (address === pool) {
        return ({ factory: UNISWAP_V3_MONAD.factory, token0: MONAD_TOKENS.WMON, token1: MONAD_TOKENS.USDC, fee: 3000,
          tickSpacing: 60, slot0: [SQRT_PRICE, -322_000, 0, 0, 0, 0, true],
          liquidity: options.liquidity ?? 10n ** 18n } as Record<string, unknown>)[functionName];
      }
      if (functionName === "decimals") return address === MONAD_TOKENS.USDC ? 6 : 18;
      if (functionName === "symbol") return address === MONAD_TOKENS.USDC ? "USDC" : "WMON";
      if (functionName === "balanceOf") return 5n * ONE_WMON;
      if (functionName === "allowance") return options.allowance ?? 0n;
      throw new Error(`Unexpected ${functionName}`);
    },
  } as unknown as MonadV3PoolClient;
  const app = createApp({ limitRequest: async () => true, createAuthStore: () => authStore, createMonadClient: () => client,
    monUsd: async () => 0.03, now: () => 1_000_000_000 });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST",
    headers: { cookie: `tideweave_session=${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
  { ...env, DB: db });
  return { post, writes };
}

const swap = { venue: "uniswap-v3", pairId: pool, tokenIn: MONAD_TOKENS.WMON, amountIn: ONE_WMON.toString(),
  slippageBps: 100 };

describe("quoting a swap", () => {
  it("quotes the output, the minimum after slippage, price impact and what still needs approving", async () => {
    const { post } = await setup();
    const response = await post("/v1/wallets/swaps/quote", swap);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ tokenOut: MONAD_TOKENS.USDC, amountOut: "29900", amountOutMinimum: "29601",
      tooMuchImpact: false, approved: false, balance: (5n * ONE_WMON).toString(),
      allowances: [{ stage: "erc20", spender: UNISWAP_V3_MONAD.swapRouter02, allowance: "0" }] });
    expect(body.priceImpactBps).toBeLessThan(10);
  });

  it("refuses a pool a few dollars could move", async () => {
    const { post } = await setup({ liquidity: 10n ** 12n });
    const response = await post("/v1/wallets/swaps/quote", swap);
    expect(await response.json()).toEqual({ error: "POOL_ALMOST_EMPTY" });
  });
});

describe("preparing a swap", () => {
  it("prepares a SwapRouter02 swap paying the wallet, under a deadline, once approved", async () => {
    const { post, writes } = await setup({ allowance: ONE_WMON });
    const response = await post("/v1/wallets/swaps/prepare", { ...swap, idempotencyKey: "swap-key-000000001" });
    expect(response.status).toBe(201);
    const body = await response.json() as { transaction: { to: string; data: Hex; value: string } };
    expect(body.transaction).toMatchObject({ to: UNISWAP_V3_MONAD.swapRouter02, value: "0" });
    const outer = decodeFunctionData({ abi: swapRouter02Abi, data: body.transaction.data });
    expect(outer.args[0]).toBe(1_000_000n + 600n);
    const inner = decodeFunctionData({ abi: swapRouter02Abi, data: (outer.args[1] as Hex[])[0] });
    expect(inner.args[0]).toMatchObject({ recipient: wallet, amountIn: ONE_WMON, amountOutMinimum: 29_601n });
    expect(writes[0].values).toContain("monad_swap");
    expect(writes[1].sql).toContain("monad_swap_intents");
  });

  it("refuses before approval, with too much price impact, or beyond the balance", async () => {
    expect(await (await (await setup()).post("/v1/wallets/swaps/prepare", { ...swap,
      idempotencyKey: "swap-key-000000002" })).json()).toEqual({ error: "SWAP_APPROVAL_REQUIRED" });
    expect(await (await (await setup({ allowance: ONE_WMON, quoteOut: 20_000n })).post("/v1/wallets/swaps/prepare",
      { ...swap, idempotencyKey: "swap-key-000000003" })).json()).toEqual({ error: "PRICE_IMPACT_TOO_HIGH" });
    // 10 WMON quoted at a fair price, but the wallet holds 5.
    expect(await (await (await setup({ allowance: 10n ** 30n, quoteOut: 299_000n })).post("/v1/wallets/swaps/prepare",
      { ...swap, amountIn: (10n * ONE_WMON).toString(), idempotencyKey: "swap-key-000000004" })).json())
      .toEqual({ error: "INSUFFICIENT_TOKEN_BALANCE" });
  });
});

describe("approving a swap's input", () => {
  it("approves SwapRouter02 for a v3 swap", async () => {
    const { post, writes } = await setup();
    const response = await post("/v1/wallets/swaps/approvals/prepare", { venue: "uniswap-v3", pairId: pool,
      tokenAddress: MONAD_TOKENS.WMON, stage: "erc20", amount: ONE_WMON.toString(),
      idempotencyKey: "swap-approval-key-1" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ transaction: { to: MONAD_TOKENS.WMON, value: "0" } });
    expect(writes[1].values).toContain(UNISWAP_V3_MONAD.swapRouter02);
  });

  it("refuses a Permit2 stage on a venue that does not use Permit2", async () => {
    const { post } = await setup();
    const response = await post("/v1/wallets/swaps/approvals/prepare", { venue: "uniswap-v3", pairId: pool,
      tokenAddress: MONAD_TOKENS.WMON, stage: "permit2", amount: "1", expiration: "1000100",
      idempotencyKey: "swap-approval-key-2" });
    expect(await response.json()).toEqual({ error: "PERMIT2_NOT_USED" });
  });
});
