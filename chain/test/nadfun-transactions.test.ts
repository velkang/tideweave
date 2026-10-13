import { decodeFunctionData, getAddress, parseAbi, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, buildNadAdd, buildNadDelegationClear, buildNadRemove,
  decodeNadBatch, nadBatchPayloadHash, type MonadNadPair } from "../src";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const meme = getAddress("0x7777777777777777777777777777777777777777");
const pairAddress = getAddress("0x4444444444444444444444444444444444444444");
const pair: MonadNadPair = { chainId: MONAD_CHAIN_ID, venue: "nadfun-v2", id: pairAddress, memeToken: meme,
  token0: { address: MONAD_TOKENS.WMON, symbol: "WMON", decimals: 18 },
  token1: { address: meme, symbol: "MEME", decimals: 18 },
  // 1 WMON = 500 MEME; 1,000,000 LP tokens exist.
  reserve0: 4_000n * 10n ** 18n, reserve1: 2_000_000n * 10n ** 18n, totalSupply: 1_000_000n * 10n ** 18n };
const erc20 = parseAbi(["function transfer(address to, uint256 value) returns (bool)", "function deposit() payable"]);
const pairAbi = parseAbi(["function mint(address to) returns (uint256)", "function burn(address to) returns (uint256, uint256)",
  "function transfer(address to, uint256 value) returns (bool)"]);
const decode = (data: Hex) => decodeFunctionData({ abi: [...erc20, ...pairAbi], data });

describe("nad.fun liquidity as one atomic batch", () => {
  it("adds both tokens in the pair's ratio, mints LP and guards the minimum LP", () => {
    // 10 WMON and far more MEME than the ratio needs: the WMON side limits the deposit.
    const add = buildNadAdd({ pair, wallet, amount0Desired: 10n * 10n ** 18n, amount1Desired: 99_999n * 10n ** 18n,
      slippageBps: 100, lpBefore: 7n });
    expect(add).toMatchObject({ chainId: 143, kind: "add", to: wallet, value: 0n, pair: pairAddress,
      amount0: 10n * 10n ** 18n, amount1: 5_000n * 10n ** 18n });
    // 10 / 4,000 of 1,000,000 LP is 2,500 LP; 1% slippage leaves 2,475.
    expect(add.minLiquidity).toBe(2_475n * 10n ** 18n);
    const calls = decodeNadBatch(add.data);
    expect(calls.map((call) => [call.target, call.value, decode(call.data)])).toEqual([
      [MONAD_TOKENS.WMON, 0n, { functionName: "transfer", args: [pairAddress, add.amount0] }],
      [meme, 0n, { functionName: "transfer", args: [pairAddress, add.amount1] }],
      [pairAddress, 0n, { functionName: "mint", args: [wallet] }],
      [pairAddress, 0n, { functionName: "transfer", args: [wallet, 7n + add.minLiquidity] }],
    ]);
  });

  it("wraps MON into WMON first when asked, from the wallet's balance, not the transaction's value", () => {
    const add = buildNadAdd({ pair, wallet, amount0Desired: 10n * 10n ** 18n, amount1Desired: 5_000n * 10n ** 18n,
      slippageBps: 100, lpBefore: 0n, wrapAmount: 3n * 10n ** 18n });
    // executeBatch is not payable.
    expect(add.value).toBe(0n);
    expect(add.wrapAmount).toBe(3n * 10n ** 18n);
    const [wrap] = decodeNadBatch(add.data);
    expect(wrap).toMatchObject({ target: MONAD_TOKENS.WMON, value: 3n * 10n ** 18n });
    expect(decode(wrap.data).functionName).toBe("deposit");
    expect(() => buildNadAdd({ pair, wallet, amount0Desired: 10n ** 18n, amount1Desired: 10n ** 24n,
      slippageBps: 100, lpBefore: 0n, wrapAmount: 2n * 10n ** 18n })).toThrow("NAD_WRAP_EXCEEDS_DEPOSIT");
  });

  it("rejects one-sided, oversized-slippage and empty-pair deposits", () => {
    const base = { pair, wallet, amount0Desired: 10n ** 18n, amount1Desired: 10n ** 21n, slippageBps: 100, lpBefore: 0n };
    expect(() => buildNadAdd({ ...base, amount1Desired: 0n })).toThrow("NAD_ADD_REQUIRES_BOTH_TOKENS");
    expect(() => buildNadAdd({ ...base, slippageBps: 501 })).toThrow("NAD_ADD_LIMITS_INVALID");
    expect(() => buildNadAdd({ ...base, pair: { ...pair, totalSupply: 0n } })).toThrow("NAD_PAIR_EMPTY");
  });

  it("removes LP by sending it to the pair and burning, then guards both minimum outputs", () => {
    const remove = buildNadRemove({ pair, wallet, liquidity: 2_500n * 10n ** 18n, slippageBps: 100,
      balance0Before: 1n, balance1Before: 2n });
    // 2,500 of 1,000,000 LP redeems 10 WMON and 5,000 MEME; 1% slippage on each.
    expect(remove).toMatchObject({ kind: "remove", value: 0n, liquidity: 2_500n * 10n ** 18n,
      amount0Min: 99n * 10n ** 17n, amount1Min: 4_950n * 10n ** 18n });
    expect(decodeNadBatch(remove.data).map((call) => [call.target, decode(call.data)])).toEqual([
      [pairAddress, { functionName: "transfer", args: [pairAddress, remove.liquidity] }],
      [pairAddress, { functionName: "burn", args: [wallet] }],
      [MONAD_TOKENS.WMON, { functionName: "transfer", args: [wallet, 1n + remove.amount0Min] }],
      [meme, { functionName: "transfer", args: [wallet, 2n + remove.amount1Min] }],
    ]);
  });

  it("clears the delegation with an empty call to the wallet itself", () => {
    expect(buildNadDelegationClear({ wallet })).toEqual({ chainId: 143, kind: "clear", to: wallet, data: "0x",
      value: 0n, delegate: zeroAddress });
  });

  it("binds the kind, pair, value and calldata into the payload hash", () => {
    const add = buildNadAdd({ pair, wallet, amount0Desired: 10n ** 18n, amount1Desired: 10n ** 21n,
      slippageBps: 100, lpBefore: 0n });
    expect(nadBatchPayloadHash(add)).not.toBe(nadBatchPayloadHash({ ...add, pair: wallet }));
    expect(nadBatchPayloadHash(add)).not.toBe(nadBatchPayloadHash({ ...add, data: `${add.data}00` as Hex }));
  });
});
