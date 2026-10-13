import { createPublicClient, createTestClient, createWalletClient, getAddress, http, parseAbi, parseEther, publicActions,
  zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, buildMonadSwap, buildSwapApproval, buildWrap, monad, quoteMonadSwap, readMonadV3Pool,
  readMonadV4Pool, type SwapPair, type SwapQuoteClient } from "../src";

// A routed swap's steps on an anvil fork of Monad mainnet, signed by a local key: wrap MON, sell the WMON in a
// v3 WMON pool, sell what came back for native MON in a v4 pool, and unwrap what WMON is left.
//   anvil --fork-url https://rpc.monad.xyz --port 8599 --chain-id 143
//   FORK_MONAD_RPC=http://127.0.0.1:8599 pnpm --filter @tideweave/chain test fork-routes
const forkUrl = process.env.FORK_MONAD_RPC;
const rpcUrl = forkUrl ?? "http://127.0.0.1:8599";
const V3_POOL = getAddress("0x659bD0BC4167BA25c62E05656F78043E7eD4a9da");
const V4_KEY = { currency0: zeroAddress, currency1: MONAD_TOKENS.USDC, fee: 500, tickSpacing: 10, hooks: zeroAddress };
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

describe.skipIf(!forkUrl)("a routed swap on a Monad fork", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const transport = http(rpcUrl);
  const chain = { ...monad, rpcUrls: { default: { http: [rpcUrl] } } };
  const reader = createPublicClient({ chain, transport });
  const client = reader as unknown as SwapQuoteClient;
  const wallet = createWalletClient({ account, chain, transport }).extend(publicActions);
  const test = createTestClient({ chain, transport, mode: "anvil" });
  const balance = (token: Address) => token === zeroAddress ? reader.getBalance({ address: account.address })
    : reader.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] });
  async function send(call: { to: Address; data: Hex; value: bigint }) {
    const receipt = await reader.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ ...call, gas: 1_500_000n }) });
    expect(receipt.status).toBe("success");
  }
  /** One swap step, as the route runs it: approve what it needs, swap, and return what arrived. */
  async function step(pair: SwapPair, tokenIn: Address, amountIn: bigint) {
    if (tokenIn !== zeroAddress) {
      await send(buildSwapApproval({ pair, token: tokenIn, stage: "erc20", amount: amountIn }));
      if (pair.venue === "uniswap-v4") {
        await send(buildSwapApproval({ pair, token: tokenIn, stage: "permit2", amount: amountIn,
          expiration: BigInt(Math.floor(Date.now() / 1000) + 86_400) }));
      }
    }
    const quote = await quoteMonadSwap({ client, pair, tokenIn, amountIn });
    const swap = buildMonadSwap({ pair, tokenIn, amountIn, amountOutMinimum: quote.amountOut * 99n / 100n,
      recipient: account.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
    const before = await balance(swap.tokenOut);
    await send(swap);
    const received = await balance(swap.tokenOut) - before;
    expect(received).toBeGreaterThanOrEqual(swap.amountOutMinimum);
    return received;
  }

  it("wraps, swaps through two pools, and unwraps", async () => {
    await test.setBalance({ address: account.address, value: parseEther("1000") });

    await send(buildWrap({ action: "wrap", amount: parseEther("100") }));
    expect(await balance(MONAD_TOKENS.WMON)).toBe(parseEther("100"));

    const usdc = await step(await readMonadV3Pool({ client, poolAddress: V3_POOL }), MONAD_TOKENS.WMON, parseEther("60"));
    const monBefore = await balance(zeroAddress);
    await step(await readMonadV4Pool({ client, key: V4_KEY }), MONAD_TOKENS.USDC, usdc);
    expect(await balance(MONAD_TOKENS.USDC)).toBe(0n);
    expect(await balance(zeroAddress)).toBeGreaterThan(monBefore - parseEther("1"));

    await send(buildWrap({ action: "unwrap", amount: await balance(MONAD_TOKENS.WMON) }));
    expect(await balance(MONAD_TOKENS.WMON)).toBe(0n);
  }, 180_000);
});
