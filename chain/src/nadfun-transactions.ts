import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi,
  zeroAddress, type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID, MONAD_TOKENS } from "./monad";
import { nadPairAbi, type MonadNadPair } from "./nadfun";

// nad.fun pairs have no router for liquidity: tokens are sent to the pair and then minted, or LP
// is sent to the pair and then burned. Done as separate transactions, anyone could mint or burn
// the funds in between, so the managed wallet runs each as one EIP-7702 batch through
// Simple7702Account.executeBatch. Its last calls transfer the wallet's own balance to itself:
// they revert, and with them the whole batch, unless the wallet received at least the minimum.
// executeBatch is not payable: the transaction sends no value, and an inner WMON wrap spends MON
// the wallet already holds.

export const simple7702Abi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls)",
]);
const tokenAbi = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);
const wmonAbi = parseAbi(["function deposit() payable"]);

export type NadCall = { target: Address; value: bigint; data: Hex };

type BatchBase = { chainId: typeof MONAD_CHAIN_ID; pair: Address; wallet: Address; to: Address; data: Hex;
  /** Always 0: executeBatch is not payable. */
  value: 0n };
export type NadAdd = BatchBase & { kind: "add"; amount0: bigint; amount1: bigint; minLiquidity: bigint;
  lpBefore: bigint;
  /** MON the batch wraps into WMON from the wallet's own balance before depositing. */
  wrapAmount: bigint; slippageBps: number };
export type NadRemove = BatchBase & { kind: "remove"; liquidity: bigint; amount0Min: bigint; amount1Min: bigint;
  balance0Before: bigint; balance1Before: bigint; slippageBps: number };
export type NadDelegationClear = { chainId: typeof MONAD_CHAIN_ID; kind: "clear"; to: Address; data: "0x";
  value: 0n; delegate: typeof zeroAddress };
export type NadBatch = NadAdd | NadRemove;

const slippageValid = (bps: number) => Number.isInteger(bps) && bps >= 0 && bps <= 500;
const lessSlippage = (amount: bigint, bps: number) => amount * BigInt(10_000 - bps) / 10_000n;

function batch(calls: NadCall[]): Hex {
  return encodeFunctionData({ abi: simple7702Abi, functionName: "executeBatch", args: [calls] });
}

const transfer = (token: Address, to: Address, amount: bigint): NadCall => ({ target: token, value: 0n,
  data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [to, amount] }) });

/** The calls inside an executeBatch calldata, for checking a batch against its template. */
export function decodeNadBatch(data: Hex): NadCall[] {
  const decoded = decodeFunctionData({ abi: simple7702Abi, data });
  return decoded.args[0].map((call) => ({ target: getAddress(call.target), value: call.value, data: call.data }));
}

/**
 * Adds liquidity at the pair's current ratio, like Uniswap V2's router: the side that would
 * overshoot is reduced. Reserves and supply are the snapshot the deposit was previewed at.
 */
export function buildNadAdd(input: { pair: MonadNadPair; wallet: Address; amount0Desired: bigint;
  amount1Desired: bigint; slippageBps: number; lpBefore: bigint; wrapAmount?: bigint }): NadAdd {
  const { pair } = input;
  const wallet = getAddress(input.wallet);
  if (input.amount0Desired <= 0n || input.amount1Desired <= 0n) throw new Error("NAD_ADD_REQUIRES_BOTH_TOKENS");
  if (!slippageValid(input.slippageBps) || input.lpBefore < 0n) throw new Error("NAD_ADD_LIMITS_INVALID");
  if (pair.totalSupply <= 0n || pair.reserve0 <= 0n || pair.reserve1 <= 0n) throw new Error("NAD_PAIR_EMPTY");
  const optimal1 = input.amount0Desired * pair.reserve1 / pair.reserve0;
  const [amount0, amount1] = optimal1 <= input.amount1Desired
    ? [input.amount0Desired, optimal1]
    : [input.amount1Desired * pair.reserve0 / pair.reserve1, input.amount1Desired];
  if (amount0 <= 0n || amount1 <= 0n) throw new Error("NAD_ADD_REQUIRES_BOTH_TOKENS");
  const liquidity0 = amount0 * pair.totalSupply / pair.reserve0;
  const liquidity1 = amount1 * pair.totalSupply / pair.reserve1;
  const minLiquidity = lessSlippage(liquidity0 < liquidity1 ? liquidity0 : liquidity1, input.slippageBps);
  if (minLiquidity <= 0n) throw new Error("NAD_ADD_TOO_SMALL");
  const wrapAmount = input.wrapAmount ?? 0n;
  const wmonAmount = pair.token0.address === MONAD_TOKENS.WMON ? amount0 : amount1;
  if (wrapAmount < 0n || wrapAmount > wmonAmount) throw new Error("NAD_WRAP_EXCEEDS_DEPOSIT");
  const calls: NadCall[] = [
    ...(wrapAmount > 0n ? [{ target: MONAD_TOKENS.WMON, value: wrapAmount,
      data: encodeFunctionData({ abi: wmonAbi, functionName: "deposit" }) }] : []),
    transfer(pair.token0.address, pair.id, amount0),
    transfer(pair.token1.address, pair.id, amount1),
    { target: pair.id, value: 0n, data: encodeFunctionData({ abi: nadPairAbi, functionName: "mint", args: [wallet] }) },
    transfer(pair.id, wallet, input.lpBefore + minLiquidity),
  ];
  return { chainId: MONAD_CHAIN_ID, kind: "add", pair: pair.id, wallet, to: wallet, data: batch(calls),
    value: 0n, amount0, amount1, minLiquidity, lpBefore: input.lpBefore, wrapAmount,
    slippageBps: input.slippageBps };
}

/** Removes `liquidity` LP tokens, guarding both outputs against the previewed reserves. */
export function buildNadRemove(input: { pair: MonadNadPair; wallet: Address; liquidity: bigint;
  slippageBps: number; balance0Before: bigint; balance1Before: bigint }): NadRemove {
  const { pair } = input;
  const wallet = getAddress(input.wallet);
  if (input.liquidity <= 0n || !slippageValid(input.slippageBps) ||
      input.balance0Before < 0n || input.balance1Before < 0n) throw new Error("NAD_REMOVE_LIMITS_INVALID");
  if (pair.totalSupply <= 0n || input.liquidity > pair.totalSupply) throw new Error("NAD_PAIR_EMPTY");
  const amount0Min = lessSlippage(input.liquidity * pair.reserve0 / pair.totalSupply, input.slippageBps);
  const amount1Min = lessSlippage(input.liquidity * pair.reserve1 / pair.totalSupply, input.slippageBps);
  if (amount0Min <= 0n && amount1Min <= 0n) throw new Error("NAD_REMOVE_TOO_SMALL");
  const calls: NadCall[] = [
    transfer(pair.id, pair.id, input.liquidity),
    { target: pair.id, value: 0n, data: encodeFunctionData({ abi: nadPairAbi, functionName: "burn", args: [wallet] }) },
    transfer(pair.token0.address, wallet, input.balance0Before + amount0Min),
    transfer(pair.token1.address, wallet, input.balance1Before + amount1Min),
  ];
  return { chainId: MONAD_CHAIN_ID, kind: "remove", pair: pair.id, wallet, to: wallet, data: batch(calls),
    value: 0n, liquidity: input.liquidity, amount0Min, amount1Min, balance0Before: input.balance0Before,
    balance1Before: input.balance1Before, slippageBps: input.slippageBps };
}

/** Ends the wallet's EIP-7702 delegation: an empty self-call carrying an authorization to address zero. */
export function buildNadDelegationClear(input: { wallet: Address }): NadDelegationClear {
  return { chainId: MONAD_CHAIN_ID, kind: "clear", to: getAddress(input.wallet), data: "0x", value: 0n,
    delegate: zeroAddress };
}

export function nadBatchPayloadHash(batched: NadBatch | NadDelegationClear): Hex {
  const pair = "pair" in batched ? batched.pair : zeroAddress;
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "bytes" }],
    [BigInt(batched.chainId), batched.kind, pair, batched.to, batched.value, batched.data],
  ));
}
