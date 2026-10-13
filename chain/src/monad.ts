import { getAddress, zeroAddress, type Address } from "viem";
import { monad } from "viem/chains";

export const MONAD_CHAIN_ID = monad.id;
export { monad };

// Official Uniswap Monad deployment manifests:
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments
// https://developers.uniswap.org/docs/protocols/v4/deployments
export const UNISWAP_V3_MONAD = {
  factory: getAddress("0x204faca1764b154221e35c0d20abb3c525710498"),
  nonfungiblePositionManager: getAddress("0x7197e214c0b767cfb76fb734ab638e2c192f4e53"),
  quoterV2: getAddress("0x661e93cca42afacb172121ef892830ca3b70f08d"),
  swapRouter02: getAddress("0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900"),
} as const satisfies Record<string, Address>;

export const UNISWAP_V4_MONAD = {
  poolManager: getAddress("0x188d586ddcf52439676ca21a244753fa19f9ea8e"),
  positionManager: getAddress("0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016"),
  quoter: getAddress("0xa222dd357a9076d1091ed6aa2e16c9742dd26891"),
  stateView: getAddress("0x77395f3b2e73ae90843717371294fa97cc419d64"),
  universalRouter: getAddress("0x0d97dc33264bfc1c226207428a79b26757fb9dc3"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
} as const satisfies Record<string, Address>;

/** Native MON, as Uniswap v4 and the withdrawal flow name it. */
export const NATIVE_MON = { address: zeroAddress, symbol: "MON", decimals: 18 } as const;

// Monad's token list: https://docs.monad.xyz/developer-essentials/network-information/tokens-and-bridges
// Each symbol and decimals value was also read from chain 143.
export const MONAD_TOKENS = {
  WMON: getAddress("0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"),
  USDC: getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"),
  USDT0: getAddress("0xe7cd86e13AC4309349F30B3435a9d337750fC82D"),
  AUSD: getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"),
  WETH: getAddress("0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242"),
  WBTC: getAddress("0x0555E30da8f98308EdB960aa94C0Db47230d2B9c"),
} as const satisfies Record<string, Address>;

/** Tokens a pasted token is looked up against when searching for its pools. */
export const MONAD_QUOTE_TOKENS: readonly Address[] = Object.values(MONAD_TOKENS);

// nad.fun V2 on Monad mainnet: https://github.com/Naddotfun/nadfun-v2-intergration
export const NADFUN_MONAD = {
  factory: getAddress("0xA25b13127e63ddae6d0b35570FF3D39dBD621001"),
  router: getAddress("0x8986C8fD44eb85294A725a7e61AF35E76bA26F91"),
  bondingCurve: getAddress("0x9f3832732923252A21044F21eE6bd87F09514ae4"),
} as const satisfies Record<string, Address>;

/** eth-infinitism Simple7702Account v0.8: the managed wallet's EIP-7702 delegate for batches. */
export const SIMPLE_7702_ACCOUNT = getAddress("0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9");
