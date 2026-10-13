import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, getAddress, http, parseAbi,
  parseEther, publicActions, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MAX_SWAP_PRICE_IMPACT_BPS, MONAD_TOKENS, buildMonadSwap, buildSwapApproval, monad, quoteMonadSwap,
  readMonadV3Pool, readMonadV4Pool, readNadPair, type SwapPair, type SwapQuoteClient } from "../src";

// Runs a real swap on each venue on an anvil fork of Monad mainnet, signed by a local key:
//   anvil --fork-url https://rpc.monad.xyz --port 8599 --chain-id 143
//   FORK_MONAD_RPC=http://127.0.0.1:8599 pnpm --filter @tideweave/chain test fork-swaps
const forkUrl = process.env.FORK_MONAD_RPC;
const rpcUrl = forkUrl ?? "http://127.0.0.1:8599";
// Live on 2026-10-07: v3 WMON/USDC 0.3%, v4 MON/USDC 0.05%, nad.fun WMON/Moncat.
const V3_POOL = getAddress("0x659bD0BC4167BA25c62E05656F78043E7eD4a9da");
const V4_KEY = { currency0: zeroAddress, currency1: MONAD_TOKENS.USDC, fee: 500, tickSpacing: 10, hooks: zeroAddress };
const NAD_PAIR = getAddress("0xbd1BEbC1CA6cE1955eD5Ec466b89da58051d8f4E");
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function deposit() payable"]);

describe.skipIf(!forkUrl)("swaps on a Monad fork", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const transport = http(rpcUrl);
  const chain = { ...monad, rpcUrls: { default: { http: [rpcUrl] } } };
  const reader = createPublicClient({ chain, transport });
  const client = reader as unknown as SwapQuoteClient;
  const wallet = createWalletClient({ account, chain, transport }).extend(publicActions);
  const test = createTestClient({ chain, transport, mode: "anvil" });
  const balance = (token: Address) => token === zeroAddress ? reader.getBalance({ address: account.address })
    : reader.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] });
  async function send(to: Address, data: Hex, value = 0n) {
    const receipt = await reader.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, data, value,
      gas: 1_500_000n }) });
    expect(receipt.status).toBe("success");
  }

  /** Approves as the venue needs, swaps `amountIn` with 1% slippage, and checks what arrived. */
  async function swap(pair: SwapPair, tokenIn: Address, amountIn: bigint) {
    const quote = await quoteMonadSwap({ client, pair, tokenIn, amountIn });
    expect(quote.priceImpactBps).toBeLessThanOrEqual(MAX_SWAP_PRICE_IMPACT_BPS);
    if (tokenIn !== zeroAddress) {
      const erc20Stage = buildSwapApproval({ pair, token: tokenIn, stage: "erc20", amount: amountIn });
      await send(erc20Stage.to, erc20Stage.data);
      if (pair.venue === "uniswap-v4") {
        const expiration = BigInt(Math.floor(Date.now() / 1000) + 86_400);
        const permit2 = buildSwapApproval({ pair, token: tokenIn, stage: "permit2", amount: amountIn, expiration });
        await send(permit2.to, permit2.data);
      }
    }
    const built = buildMonadSwap({ pair, tokenIn, amountIn, amountOutMinimum: quote.amountOut * 99n / 100n,
      recipient: account.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
    // A minimum above what the pool gives makes the whole swap revert.
    const greedy = buildMonadSwap({ pair, tokenIn, amountIn, amountOutMinimum: quote.amountOut * 2n,
      recipient: account.address, deadline: built.deadline });
    await expect(reader.call({ account: account.address, to: greedy.to, data: greedy.data, value: greedy.value }))
      .rejects.toThrow();
    const before = await balance(built.tokenOut);
    await send(built.to, built.data, built.value);
    expect(await balance(built.tokenOut) - before).toBeGreaterThanOrEqual(built.amountOutMinimum);
  }

  it("swaps on Uniswap v3, Uniswap v4 (native MON both ways) and nad.fun", async () => {
    await test.setBalance({ address: account.address, value: parseEther("1000") });
    await send(MONAD_TOKENS.WMON, encodeFunctionData({ abi: erc20, functionName: "deposit" }), parseEther("200"));

    await swap(await readMonadV3Pool({ client, poolAddress: V3_POOL }), MONAD_TOKENS.WMON, parseEther("50"));

    const v4 = await readMonadV4Pool({ client, key: V4_KEY });
    await swap(v4, zeroAddress, parseEther("50"));
    await swap(await readMonadV4Pool({ client, key: V4_KEY }), MONAD_TOKENS.USDC, await balance(MONAD_TOKENS.USDC) / 2n);

    const nad = await readNadPair({ client, pairAddress: NAD_PAIR });
    await swap(nad, MONAD_TOKENS.WMON, parseEther("10"));
    await swap(await readNadPair({ client, pairAddress: NAD_PAIR }), nad.memeToken, await balance(nad.memeToken) / 2n);
  }, 180_000);
});
