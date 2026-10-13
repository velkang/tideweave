import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseAbi,
  parseEther, publicActions, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MONAD_TOKENS, SIMPLE_7702_ACCOUNT, buildNadAdd, buildNadDelegationClear, buildNadRemove,
  monad, readDelegate, readNadPair, simple7702Abi, type MonadV3PoolClient } from "../src";

// Runs the nad.fun batches for real on an anvil fork of Monad mainnet, signed by a local key:
//   anvil --fork-url https://rpc.monad.xyz --port 8599 --chain-id 143
//   FORK_MONAD_RPC=http://127.0.0.1:8599 pnpm --filter @tideweave/chain test fork-nadfun
const forkUrl = process.env.FORK_MONAD_RPC;
// The suite is skipped without FORK_MONAD_RPC, but its clients are still built while collecting.
const rpcUrl = forkUrl ?? "http://127.0.0.1:8599";
// A graduated pair that held liquidity on 2026-10-07: WMON / Moncat.
const PAIR = "0xbd1BEbC1CA6cE1955eD5Ec466b89da58051d8f4E" as Address;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)", "function deposit() payable"]);
const pairAbi = parseAbi(["function getAmountOut(address tokenIn, uint256 amountIn) view returns (uint256)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)"]);

describe.skipIf(!forkUrl)("nad.fun liquidity batches on a Monad fork", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const transport = http(rpcUrl);
  const chain = { ...monad, rpcUrls: { default: { http: [rpcUrl] } } };
  const reader = createPublicClient({ chain, transport });
  const client = reader as unknown as MonadV3PoolClient;
  const wallet = createWalletClient({ account, chain, transport }).extend(publicActions);
  const test = createTestClient({ chain, transport, mode: "anvil" });
  const balance = (token: Address) => reader.readContract({ address: token, abi: erc20, functionName: "balanceOf",
    args: [account.address] });

  async function send(data: Hex, value = 0n, authorizationAddress?: Address) {
    const authorizationList = authorizationAddress === undefined ? undefined
      : [await wallet.signAuthorization({ contractAddress: authorizationAddress, executor: "self" })];
    const hash = await wallet.sendTransaction({ to: account.address, data, value, authorizationList, gas: 1_500_000n });
    return reader.waitForTransactionReceipt({ hash });
  }

  it("delegates, adds liquidity, removes it and clears the delegation", async () => {
    await test.setBalance({ address: account.address, value: parseEther("100") });
    const pair = await readNadPair({ client, pairAddress: PAIR });
    const meme = pair.memeToken;

    // Setup in the first, delegating batch: wrap MON and buy some of the meme token from the pair.
    const spend = parseEther("2");
    const memeOut = await reader.readContract({ address: PAIR, abi: pairAbi, functionName: "getAmountOut",
      args: [MONAD_TOKENS.WMON, spend] }) * 99n / 100n;
    const wmonIsToken0 = pair.token0.address === MONAD_TOKENS.WMON;
    const setup = encodeFunctionData({ abi: simple7702Abi, functionName: "executeBatch", args: [[
      { target: MONAD_TOKENS.WMON, value: parseEther("10"), data: encodeFunctionData({ abi: erc20, functionName: "deposit" }) },
      { target: MONAD_TOKENS.WMON, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [PAIR, spend] }) },
      { target: PAIR, value: 0n, data: encodeFunctionData({ abi: pairAbi, functionName: "swap",
        args: [wmonIsToken0 ? 0n : memeOut, wmonIsToken0 ? memeOut : 0n, account.address, "0x"] }) },
    ]] });
    expect((await send(setup, 0n, SIMPLE_7702_ACCOUNT)).status).toBe("success");
    expect(await readDelegate(reader, account.address)).toBe(SIMPLE_7702_ACCOUNT);
    expect(await balance(meme)).toBeGreaterThan(0n);

    // Add: both tokens in the pair's ratio, minted to the wallet, guarded by the minimum LP.
    const live = await readNadPair({ client, pairAddress: PAIR });
    const memeHeld = await balance(meme);
    const add = buildNadAdd({ pair: live, wallet: account.address, slippageBps: 100, lpBefore: 0n,
      amount0Desired: wmonIsToken0 ? parseEther("5") : memeHeld,
      amount1Desired: wmonIsToken0 ? memeHeld : parseEther("5") });
    expect((await send(add.data)).status).toBe("success");
    const lp = await balance(PAIR);
    expect(lp).toBeGreaterThanOrEqual(add.minLiquidity);

    // An add whose minimum cannot be met reverts as a whole: no tokens leave the wallet.
    const impossible = buildNadAdd({ pair: live, wallet: account.address, slippageBps: 0,
      lpBefore: lp + 10n ** 30n, amount0Desired: parseEther("1"), amount1Desired: parseEther("1") * 10n ** 6n });
    await expect(reader.call({ account: account.address, to: account.address, data: impossible.data }))
      .rejects.toThrow();

    // Remove everything, guarded by the minimum of each token.
    const before = [await balance(pair.token0.address), await balance(pair.token1.address)];
    const remove = buildNadRemove({ pair: await readNadPair({ client, pairAddress: PAIR }), wallet: account.address,
      liquidity: lp, slippageBps: 100, balance0Before: before[0], balance1Before: before[1] });
    expect((await send(remove.data)).status).toBe("success");
    expect(await balance(PAIR)).toBe(0n);
    expect(await balance(pair.token0.address)).toBeGreaterThanOrEqual(before[0] + remove.amount0Min);
    expect(await balance(pair.token1.address)).toBeGreaterThanOrEqual(before[1] + remove.amount1Min);

    // Clearing the delegation leaves a plain account again.
    const clear = buildNadDelegationClear({ wallet: account.address });
    expect((await send(clear.data, 0n, zeroAddress)).status).toBe("success");
    expect(await readDelegate(reader, account.address)).toBeNull();
  }, 120_000);
});
