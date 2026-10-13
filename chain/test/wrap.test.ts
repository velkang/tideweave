import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_CHAIN_ID, MONAD_TOKENS, buildWrap, wrapPayloadHash } from "../src";

const wmonAbi = parseAbi(["function deposit() payable", "function withdraw(uint256 amount)"]);

describe("wrapping MON", () => {
  it("wraps by sending MON to WMON.deposit", () => {
    const wrap = buildWrap({ action: "wrap", amount: 5n });
    expect(wrap).toMatchObject({ chainId: MONAD_CHAIN_ID, action: "wrap", amount: 5n, to: MONAD_TOKENS.WMON, value: 5n });
    expect(decodeFunctionData({ abi: wmonAbi, data: wrap.data }).functionName).toBe("deposit");
  });

  it("unwraps with WMON.withdraw and sends no MON", () => {
    const unwrap = buildWrap({ action: "unwrap", amount: 7n });
    expect(unwrap.value).toBe(0n);
    expect(decodeFunctionData({ abi: wmonAbi, data: unwrap.data })).toMatchObject({ functionName: "withdraw", args: [7n] });
  });

  it("hashes the action and amount", () => {
    expect(wrapPayloadHash(buildWrap({ action: "wrap", amount: 5n })))
      .not.toBe(wrapPayloadHash(buildWrap({ action: "unwrap", amount: 5n })));
    expect(wrapPayloadHash(buildWrap({ action: "wrap", amount: 5n })))
      .not.toBe(wrapPayloadHash(buildWrap({ action: "wrap", amount: 6n })));
  });

  it("refuses a zero or negative amount", () => {
    expect(() => buildWrap({ action: "wrap", amount: 0n })).toThrow("INVALID_WRAP");
    expect(() => buildWrap({ action: "unwrap", amount: -1n })).toThrow("INVALID_WRAP");
  });
});
