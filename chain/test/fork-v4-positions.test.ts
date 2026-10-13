import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther,
  publicActions, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, buildMonadSwap, buildMonadV4Approval, buildMonadV4Mint, buildMonadV4PositionAction,
  monad, monadV4MintedTokenIds, quoteMonadSwap, readMonadV4Pool, readMonadV4Position, type MonadV3PoolClient,
  type SwapQuoteClient } from "../src";

// Opens a native-MON v4 position, removes a quarter of it, then closes it, on an anvil fork of Monad mainnet:
//   anvil --fork-url https://rpc.monad.xyz --port 8599 --chain-id 143
//   FORK_MONAD_RPC=http://127.0.0.1:8599 pnpm --filter @tideweave/chain test fork-v4-positions
const forkUrl = process.env.FORK_MONAD_RPC;
const rpcUrl = forkUrl ?? "http://127.0.0.1:8599";
const V4_KEY = { currency0: zeroAddress, currency1: MONAD_TOKENS.USDC, fee: 500, tickSpacing: 10, hooks: zeroAddress };
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

describe.skipIf(!forkUrl)("v4 positions on a Monad fork", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const transport = http(rpcUrl);
  const chain = { ...monad, rpcUrls: { default: { http: [rpcUrl] } } };
  const reader = createPublicClient({ chain, transport });
  const client = reader as unknown as MonadV3PoolClient;
  const wallet = createWalletClient({ account, chain, transport }).extend(publicActions);
  const test = createTestClient({ chain, transport, mode: "anvil" });
  const usdc = () => reader.readContract({ address: MONAD_TOKENS.USDC, abi: erc20, functionName: "balanceOf",
    args: [account.address] });
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
  async function send(to: Address, data: Hex, value = 0n) {
    const receipt = await reader.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, data, value,
      gas: 2_000_000n }) });
    expect(receipt.status).toBe("success");
    return receipt;
  }

  it("removes part of a position, keeping the NFT, then closes it", async () => {
    await test.setBalance({ address: account.address, value: parseEther("1000") });
    let pool = await readMonadV4Pool({ client, key: V4_KEY });
    // Buy USDC with native MON, then approve it for the position manager through Permit2.
    const quote = await quoteMonadSwap({ client: reader as unknown as SwapQuoteClient, pair: pool,
      tokenIn: zeroAddress, amountIn: parseEther("200") });
    const swap = buildMonadSwap({ pair: pool, tokenIn: zeroAddress, amountIn: parseEther("200"),
      amountOutMinimum: quote.amountOut * 99n / 100n, recipient: account.address, deadline: deadline() });
    await send(swap.to, swap.data, swap.value);
    const bought = await usdc();
    for (const stage of ["erc20", "permit2"] as const) {
      const approval = buildMonadV4Approval({ pool, token: MONAD_TOKENS.USDC, stage, amount: bought,
        expiration: BigInt(Math.floor(Date.now() / 1000) + 86_400) });
      await send(approval.to, approval.data);
    }
    pool = await readMonadV4Pool({ client, key: V4_KEY });
    const center = Math.floor(pool.tick / pool.tickSpacing) * pool.tickSpacing;
    const mint = buildMonadV4Mint({ pool, recipient: account.address, tickLower: center - 200, tickUpper: center + 200,
      amount0Desired: parseEther("150"), amount1Desired: bought, slippageBps: 100, deadline: deadline() });
    const receipt = await send(mint.to, mint.data, mint.value);
    const [tokenId] = monadV4MintedTokenIds(receipt.logs, account.address);
    const opened = await readMonadV4Position({ client, owner: account.address, tokenId });

    // A quarter: the NFT stays, three quarters of the liquidity remain, and both tokens come back.
    const [usdcBefore, monBefore] = [await usdc(), await reader.getBalance({ address: account.address })];
    const quarter = buildMonadV4PositionAction({ kind: "decrease", removeBps: 2_500, position: opened,
      recipient: account.address, slippageBps: 100, deadline: deadline() });
    const removed = await send(quarter.to, quarter.data);
    const gas = removed.gasUsed * removed.effectiveGasPrice;
    const reduced = await readMonadV4Position({ client, owner: account.address, tokenId });
    expect(reduced.liquidity).toBe(opened.liquidity - opened.liquidity / 4n);
    expect(await usdc()).toBeGreaterThan(usdcBefore);
    expect(await reader.getBalance({ address: account.address }) + gas).toBeGreaterThan(monBefore);

    // Closing burns the NFT and returns the rest.
    const close = buildMonadV4PositionAction({ kind: "withdraw", position: reduced, recipient: account.address,
      slippageBps: 100, deadline: deadline() });
    await send(close.to, close.data);
    await expect(readMonadV4Position({ client, owner: account.address, tokenId })).rejects.toThrow();
  }, 120_000);
});
