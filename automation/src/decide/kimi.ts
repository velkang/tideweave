import { DECISION_SCHEMA, factsMessage, parseDecision, SYSTEM_PROMPT } from "./decision";
import type { Decider, DeciderResult } from "./provider";

export const DEFAULT_KIMI_MODEL = "kimi-k2.6";
const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";

function endpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || !["api.moonshot.ai", "api.moonshot.cn"].includes(url.hostname) || url.port ||
      url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw new Error("MOONSHOT_BASE_URL must be the official HTTPS /v1 endpoint");
  }
  return `${url.origin}/v1/chat/completions`;
}

/** One bounded Kimi call; code validates the answer before any action is considered. */
export function kimiDecider(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
}): Decider {
  const model = options.model || DEFAULT_KIMI_MODEL;
  if (!model.startsWith("kimi-")) throw new Error("AGENT_KIMI_MODEL must be a Kimi model");
  const url = endpoint(options.baseUrl || DEFAULT_BASE_URL);
  const fetcher = options.fetcher ?? fetch;
  return {
    provider: "kimi",
    model,
    async decide(facts) {
      const response = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          response_format: { type: "json_object" },
          ...(model === "kimi-k2.6" ? { thinking: { type: "disabled" } } : {}),
          messages: [
            { role: "system", content: `${SYSTEM_PROMPT}\n\nReturn only one JSON object matching this schema: ${JSON.stringify(DECISION_SCHEMA)}` },
            { role: "user", content: factsMessage(facts) },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Kimi API returned HTTP ${response.status}`);
      const body = await response.json() as {
        model?: unknown;
        choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
      };
      const served = typeof body?.model === "string" ? body.model : model;
      const choice = body?.choices?.[0];
      const result = (decision: DeciderResult["decision"], note?: string): DeciderResult =>
        ({ provider: "kimi", model: served, decision, ...(note ? { note } : {}) });
      if (choice?.finish_reason !== "stop") return result(null, "incomplete");
      const decision = typeof choice.message?.content === "string" ? parseDecision(choice.message.content) : null;
      return result(decision, decision ? undefined : "invalid");
    },
  };
}
