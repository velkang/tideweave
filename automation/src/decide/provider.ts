import type { Decision, DecisionFacts } from "./decision";
import { kimiDecider } from "./kimi";

export type Provider = "kimi";

export type DeciderResult = {
  provider: Provider;
  model: string;
  /** Null when the provider refused, was cut off, or answered outside the fixed shape. */
  decision: Decision | null;
  note?: string;
};

export interface Decider {
  provider: Provider;
  model: string;
  decide(facts: DecisionFacts): Promise<DeciderResult>;
}

/** A failed Kimi call holds the position. */
export async function decide(facts: DecisionFacts, decider: Decider): Promise<DeciderResult> {
  try {
    return await decider.decide(facts);
  } catch (error) {
    console.warn("Automation decision from Kimi failed", error);
    return { provider: decider.provider, model: decider.model, decision: null, note: "error" };
  }
}

export type DeciderEnv = {
  AGENT_PROVIDER?: string;
  AGENT_KIMI_MODEL?: string;
  MOONSHOT_API_KEY?: string;
  MOONSHOT_BASE_URL?: string;
};

/** Kimi is the only configured model; missing credentials make automation hold. */
export function decidersFromEnv(env: DeciderEnv): { primary: Decider } | null {
  if ((env.AGENT_PROVIDER && env.AGENT_PROVIDER !== "kimi") || !env.MOONSHOT_API_KEY) return null;
  return { primary: kimiDecider({ apiKey: env.MOONSHOT_API_KEY, baseUrl: env.MOONSHOT_BASE_URL,
    model: env.AGENT_KIMI_MODEL }) };
}
