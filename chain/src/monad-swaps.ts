import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi,
  zeroAddress, type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID, NADFUN_MONAD, UNISWAP_V3_MONAD, UNISWAP_V4_MONAD } from "./monad";
import type { MonadV4Pool } from "./monad-v4-pool";
import type { MonadNadPair } from "./nadfun";
import type { MonadV3Pool, MonadV3PoolClient } from "./pair-pool";
import { MAX_PRICE_IMPACT_BPS, priceImpactBps } from "./range-math";

// One exact-input swap in one pool, on any venue: Uniswap v3 through SwapRouter02, Uniswap v4
// through UniversalRouter, and nad.fun through its router (which applies nad.fun's extra fees).
// Proceeds always go to the managed wallet.

export type SwapPair = MonadV3Pool | MonadV4Pool | MonadNadPair;
export type SwapQuoteClient = MonadV3PoolClient & {
  call(input: { account?: Address; to: Address; data: Hex; blockNumber?: bigint }): Promise<{ data?: Hex }>;
};

export { MAX_PRICE_IMPACT_BPS };

const v3QuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
export const swapRouter02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
export const nadRouterAbi = parseAbi([
  "function getAmountOut(address token, uint256 amountIn, bool isBuy) view returns (uint256)",
  "function buy((uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline) params) returns (uint256)",
  "function sell((uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline) params) returns (uint256)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

// UniversalRouter V4_SWAP command, and v4 actions SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL.
const V4_SWAP = "0x10";
const V4_ACTIONS = "0x060c0f";

const tokensOf = (pair: SwapPair) => [pair.token0.address, pair.token1.address] as [Address, Address];

/** The other token of the pair; throws when `tokenIn` is not one of its two. */
export function swapTokenOut(pair: SwapPair, tokenIn: Address): Address {
  const [token0, token1] = tokensOf(pair);
  const input = getAddress(tokenIn);
  if (input !== token0 && input !== token1) throw new Error("SWAP_TOKEN_NOT_IN_PAIR");
  return input === token0 ? token1 : token0;
}

/** Who a swap's input token must be approved to: SwapRouter02, Permit2 (for UniversalRouter) or nad.fun's router. */
export function swapSpender(venue: SwapPair["venue"]): { erc20Spender: Address; permit2Spender: Address | null } {
  if (venue === "uniswap-v3") return { erc20Spender: UNISWAP_V3_MONAD.swapRouter02, permit2Spender: null };
  if (venue === "uniswap-v4") return { erc20Spender: UNISWAP_V4_MONAD.permit2,
    permit2Spender: UNISWAP_V4_MONAD.universalRouter };
  return { erc20Spender: NADFUN_MONAD.router, permit2Spender: null };
}

async function callQuoter(client: SwapQuoteClient, to: Address, data: Hex, blockNumber?: bigint) {
  const result = await client.call({ to, data, blockNumber });
  if (!result.data || result.data === "0x") throw new Error("SWAP_QUOTE_UNAVAILABLE");
  return result.data;
}

/** Output of `amountIn` alone, without any price impact check. */
async function quoteOut(client: SwapQuoteClient, pair: SwapPair, tokenIn: Address, amountIn: bigint,
  blockNumber?: bigint): Promise<bigint> {
  const tokenOut = swapTokenOut(pair, tokenIn);
  if (pair.venue === "uniswap-v3") {
    const data = await callQuoter(client, UNISWAP_V3_MONAD.quoterV2, encodeFunctionData({ abi: v3QuoterAbi,
      functionName: "quoteExactInputSingle", args: [{ tokenIn: getAddress(tokenIn), tokenOut, amountIn,
        fee: pair.fee, sqrtPriceLimitX96: 0n }] }), blockNumber);
    return decodeFunctionResult({ abi: v3QuoterAbi, functionName: "quoteExactInputSingle", data })[0];
  }
  if (pair.venue === "uniswap-v4") {
    if (amountIn > (1n << 127n) - 1n) throw new Error("SWAP_AMOUNT_TOO_LARGE");
    const data = await callQuoter(client, UNISWAP_V4_MONAD.quoter, encodeFunctionData({ abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle", args: [{ poolKey: { currency0: pair.currency0,
        currency1: pair.currency1, fee: pair.fee, tickSpacing: pair.tickSpacing, hooks: pair.hooks },
      zeroForOne: getAddress(tokenIn) === pair.currency0, exactAmount: amountIn, hookData: "0x" }] }), blockNumber);
    return decodeFunctionResult({ abi: v4QuoterAbi, functionName: "quoteExactInputSingle", data })[0];
  }
  const out = await client.readContract({ address: NADFUN_MONAD.router, abi: nadRouterAbi, functionName: "getAmountOut",
    args: [pair.memeToken, amountIn, getAddress(tokenIn) !== pair.memeToken], blockNumber });
  if (typeof out !== "bigint") throw new Error("SWAP_QUOTE_UNAVAILABLE");
  return out;
}

/**
 * Quotes an exact-input swap and how much worse it fills than the pool's current price, in basis
 * points. v3 and v4 measure against the pool price after the LP fee; nad.fun, whose fees vary by
 * pair, measures against a quote for a thousandth of the amount, which carries the same fees.
 */
export async function quoteMonadSwap(input: { client: SwapQuoteClient; pair: SwapPair; tokenIn: Address;
  amountIn: bigint; blockNumber?: bigint }): Promise<{ amountOut: bigint; priceImpactBps: number }> {
  const { client, pair, amountIn, blockNumber } = input;
  if (amountIn <= 0n) throw new Error("SWAP_AMOUNT_INVALID");
  const amountOut = await quoteOut(client, pair, input.tokenIn, amountIn, blockNumber);
  if (amountOut <= 0n) throw new Error("SWAP_QUOTE_UNAVAILABLE");
  if (pair.venue !== "nadfun-v2") {
    const zeroForOne = getAddress(input.tokenIn) === pair.token0.address;
    return { amountOut, priceImpactBps: priceImpactBps({ sqrtPriceX96: pair.sqrtPriceX96.toString(), zeroForOne,
      amountIn, amountOut, feePips: pair.venue === "uniswap-v4" ? pair.lpFee : pair.fee }) };
  }
  const reference = amountIn / 1_000n > 0n ? amountIn / 1_000n : 1n;
  const referenceOut = await quoteOut(client, pair, input.tokenIn, reference, blockNumber);
  if (referenceOut <= 0n) return { amountOut, priceImpactBps: 10_000 };
  const fair = Number(amountIn) * Number(referenceOut) / Number(reference);
  const impact = Math.round((1 - Number(amountOut) / fair) * 10_000);
  return { amountOut, priceImpactBps: Math.min(10_000, Math.max(0, impact)) };
}

export type MonadSwap = {
  chainId: typeof MONAD_CHAIN_ID;
  venue: SwapPair["venue"];
  pairId: Address | Hex;
  to: Address;
  data: Hex;
  /** Native MON sold into a v4 pool is sent as value; everything else sends none. */
  value: bigint;
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
};

function v4SwapCalldata(pair: MonadV4Pool, tokenIn: Address, tokenOut: Address, amountIn: bigint,
  amountOutMinimum: bigint, deadline: bigint): Hex {
  const swap = encodeAbiParameters([{ type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: [
      { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
    { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
  [{ poolKey: { currency0: pair.currency0, currency1: pair.currency1, fee: pair.fee, tickSpacing: pair.tickSpacing,
    hooks: pair.hooks }, zeroForOne: tokenIn === pair.currency0, amountIn, amountOutMinimum, hookData: "0x" }]);
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenIn, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenOut, amountOutMinimum]);
  const actions = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [V4_ACTIONS, [swap, settle, take]]);
  return encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [V4_SWAP, [actions], deadline] });
}

/** Builds an exact-input swap of `amountIn` that reverts unless `amountOutMinimum` arrives by `deadline`. */
export function buildMonadSwap(input: { pair: SwapPair; tokenIn: Address; amountIn: bigint; amountOutMinimum: bigint;
  recipient: Address; deadline: bigint }): MonadSwap {
  const { pair, amountIn, amountOutMinimum, deadline } = input;
  if (amountIn <= 0n || amountOutMinimum <= 0n || deadline <= 0n || amountIn > (1n << 127n) - 1n ||
      amountOutMinimum > (1n << 127n) - 1n) throw new Error("SWAP_LIMITS_INVALID");
  const tokenIn = getAddress(input.tokenIn);
  const tokenOut = swapTokenOut(pair, tokenIn);
  const recipient = getAddress(input.recipient);
  const base = { chainId: MONAD_CHAIN_ID, venue: pair.venue, pairId: pair.id, tokenIn, tokenOut, recipient, amountIn,
    amountOutMinimum, deadline };
  if (pair.venue === "uniswap-v3") {
    const call = encodeFunctionData({ abi: swapRouter02Abi, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut,
      fee: pair.fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }] });
    return { ...base, to: UNISWAP_V3_MONAD.swapRouter02, value: 0n,
      data: encodeFunctionData({ abi: swapRouter02Abi, functionName: "multicall", args: [deadline, [call]] }) };
  }
  if (pair.venue === "uniswap-v4") {
    // TAKE_ALL pays the output to the caller, which is the managed wallet itself.
    return { ...base, to: UNISWAP_V4_MONAD.universalRouter, value: tokenIn === zeroAddress ? amountIn : 0n,
      data: v4SwapCalldata(pair, tokenIn, tokenOut, amountIn, amountOutMinimum, deadline) };
  }
  const params = { amountIn, amountOutMin: amountOutMinimum, token: pair.memeToken, to: recipient, deadline };
  return { ...base, to: NADFUN_MONAD.router, value: 0n, data: encodeFunctionData({ abi: nadRouterAbi,
    functionName: tokenIn === pair.memeToken ? "sell" : "buy", args: [params] }) };
}

export function monadSwapPayloadHash(swap: MonadSwap): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "string" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" },
      { type: "bytes" }],
    [BigInt(swap.chainId), swap.venue, keccak256(swap.pairId), swap.to, swap.value, swap.data],
  ));
}

export type SwapApproval = {
  chainId: typeof MONAD_CHAIN_ID;
  venue: SwapPair["venue"];
  stage: "erc20" | "permit2";
  token: Address;
  spender: Address;
  amount: bigint;
  expiration: bigint;
  to: Address;
  data: Hex;
  value: 0n;
};

/** Approves a swap's input token: to the venue's router, or for v4 to Permit2 and then UniversalRouter through it. */
export function buildSwapApproval(input: { pair: SwapPair; token: Address; stage: "erc20" | "permit2"; amount: bigint;
  expiration?: bigint }): SwapApproval {
  const token = getAddress(input.token);
  swapTokenOut(input.pair, token);
  if (token === zeroAddress) throw new Error("NATIVE_NEEDS_NO_APPROVAL");
  if (input.amount <= 0n || input.amount > (1n << 160n) - 1n) throw new Error("SWAP_APPROVAL_AMOUNT_INVALID");
  const spenders = swapSpender(input.pair.venue);
  const base = { chainId: MONAD_CHAIN_ID, venue: input.pair.venue, stage: input.stage, token, amount: input.amount,
    value: 0n as const };
  if (input.stage === "erc20") {
    return { ...base, spender: spenders.erc20Spender, expiration: 0n, to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spenders.erc20Spender, input.amount] }) };
  }
  const expiration = input.expiration ?? 0n;
  if (!spenders.permit2Spender) throw new Error("PERMIT2_NOT_USED");
  if (expiration <= 0n || expiration > (1n << 48n) - 1n) throw new Error("INVALID_PERMIT2_EXPIRATION");
  return { ...base, spender: spenders.permit2Spender, expiration, to: UNISWAP_V4_MONAD.permit2,
    data: encodeFunctionData({ abi: permit2Abi, functionName: "approve",
      args: [token, spenders.permit2Spender, input.amount, Number(expiration)] }) };
}

export function swapApprovalPayloadHash(approval: SwapApproval): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "uint256" }, { type: "bytes" }],
    [BigInt(approval.chainId), approval.venue, approval.token, approval.spender, approval.amount, approval.expiration,
      approval.data],
  ));
}
