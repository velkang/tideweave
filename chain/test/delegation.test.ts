import { getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MONAD_DELEGATED_RESERVE, SIMPLE_7702_ACCOUNT, readDelegate } from "../src";

const wallet = getAddress("0x5555555555555555555555555555555555555555");
const withCode = (code: Hex | undefined) => ({ getCode: async () => code });

describe("EIP-7702 delegation", () => {
  it("reads the delegate from the 0xef0100 designator", async () => {
    const code = `0xef0100${SIMPLE_7702_ACCOUNT.slice(2).toLowerCase()}` as Hex;
    expect(await readDelegate(withCode(code), wallet)).toBe(SIMPLE_7702_ACCOUNT);
  });

  it("reports a plain account, or any other code, as not delegated", async () => {
    expect(await readDelegate(withCode(undefined), wallet)).toBeNull();
    expect(await readDelegate(withCode("0x"), wallet)).toBeNull();
    expect(await readDelegate(withCode("0x6000"), wallet)).toBeNull();
  });

  it("keeps Monad's 10 MON reserve for a delegated account", () => {
    expect(MONAD_DELEGATED_RESERVE).toBe(10n * 10n ** 18n);
  });
});
