import type { MonadV3IntentKind } from "./monad-v3-policy";
import type { MonadV4IntentKind } from "./monad-v4-policy";
import type { NadIntentKind } from "./monad-nadfun-policy";
import type { WrapIntentKind } from "./monad-wrap-policy";

export type MainnetIntentKind = MonadV3IntentKind | MonadV4IntentKind | NadIntentKind |
  "monad_swap" | "monad_swap_approval" | WrapIntentKind | "monad_withdrawal";
