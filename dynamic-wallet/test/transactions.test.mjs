import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ALLOWED_DELEGATES, parseUnsignedTransaction, signedMismatches } from "../src/transactions.mjs";

const [SIMPLE_7702_ACCOUNT] = ALLOWED_DELEGATES;
const account = privateKeyToAccount(generatePrivateKey());
const base = { chainId: 143, nonce: 4, to: account.address, data: "0x1234", value: "0", gas: "300000",
  maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000000" };
const type4 = (authorization = {}) => ({ ...base, type: "eip7702",
  authorizationList: [{ chainId: 143, address: SIMPLE_7702_ACCOUNT, nonce: 5, ...authorization }] });

describe("what the service agrees to sign", () => {
  it("accepts Monad EIP-1559, and EIP-7702 delegating to Simple7702Account or clearing", () => {
    assert.equal(parseUnsignedTransaction({ ...base, type: "eip1559" }).type, "eip1559");
    assert.equal(parseUnsignedTransaction(type4()).authorizationList[0].nonce, 5);
    assert.equal(parseUnsignedTransaction(type4({ address: zeroAddress })).authorizationList[0].address, zeroAddress);
  });

  it("refuses another chain, another delegate, a wrong authorization nonce or several authorizations", () => {
    assert.throws(() => parseUnsignedTransaction({ ...base, type: "eip1559", chainId: 1 }), /INVALID_TRANSACTION/);
    assert.throws(() => parseUnsignedTransaction(type4({ address: account.address })), /INVALID_TRANSACTION/);
    assert.throws(() => parseUnsignedTransaction(type4({ nonce: 4 })), /INVALID_TRANSACTION/);
    assert.throws(() => parseUnsignedTransaction(type4({ chainId: 1 })), /INVALID_TRANSACTION/);
    const two = type4();
    two.authorizationList.push(two.authorizationList[0]);
    assert.throws(() => parseUnsignedTransaction(two), /INVALID_TRANSACTION/);
    assert.throws(() => parseUnsignedTransaction({ ...base, type: "eip1559", authorizationList: [] }), /INVALID_TRANSACTION/);
    assert.throws(() => parseUnsignedTransaction({ ...base, type: "legacy" }), /INVALID_TRANSACTION/);
  });
});

describe("checking what was signed", () => {
  const request = parseUnsignedTransaction(type4());
  const sign = async (signer = account, contractAddress = SIMPLE_7702_ACCOUNT) => {
    const authorization = await signer.signAuthorization({ chainId: 143, contractAddress, nonce: 5 });
    return account.signTransaction({ ...request, authorizationList: [authorization] });
  };

  it("finds nothing wrong with the exact transaction and authorization", async () => {
    assert.deepEqual(await signedMismatches(await sign(), request, account.address), []);
  });

  it("names a swapped delegate or an authorization signed by someone else", async () => {
    assert.deepEqual(await signedMismatches(await sign(account, zeroAddress), request, account.address),
      ["authorization", "authority"]);
    const stranger = privateKeyToAccount(generatePrivateKey());
    assert.deepEqual(await signedMismatches(await sign(stranger), request, account.address), ["authority"]);
  });
});
