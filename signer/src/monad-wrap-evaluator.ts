import { MONAD_TOKENS, buildWrap } from "@tideweave/chain";
import { parseAbi } from "viem";
import type { LoadedMainnetIntent, MainnetAuditClient, MainnetEvaluation } from "./mainnet-evaluator";
import { isWrapIntentKind, validateWrapIntent } from "./monad-wrap-policy";

const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

/** Re-checks a wrap or unwrap against the chain just before signing: the balance it spends, and a simulation. */
export async function evaluateWrapLoaded(input: { loaded: LoadedMainnetIntent; client: MainnetAuditClient;
  blockNumber: bigint; emergencyStop: boolean; now: number }): Promise<MainnetEvaluation> {
  const { loaded, client, blockNumber, now } = input;
  const finish = (decision: "allowed" | "rejected", reasonCode: string): MainnetEvaluation => ({
    intentId: loaded.intentId, decision, reasonCode, blockNumber: Number(blockNumber), createdAt: now });
  const stored = loaded.monadWrap;
  if (!stored || !isWrapIntentKind(loaded.kind)) return finish("rejected", "WRAP_CONTEXT_MISSING");
  try {
    const expected = buildWrap(stored);
    const owner = loaded.wallet.address;
    const held = stored.action === "wrap" ? await client.getBalance({ address: owner, blockNumber })
      : await client.readContract({ address: MONAD_TOKENS.WMON, abi: balanceAbi, functionName: "balanceOf",
        args: [owner], blockNumber } as never) as bigint;
    const holdsEnough = held >= stored.amount;
    if (holdsEnough) {
      await client.call({ account: owner, to: loaded.transaction.to, data: loaded.transaction.data,
        value: loaded.transaction.value, blockNumber });
    }
    const decision = validateWrapIntent({ now, emergencyStop: input.emergencyStop, automated: Boolean(loaded.automation),
      wallet: loaded.wallet, intent: { kind: loaded.kind, status: loaded.status, expiresAt: loaded.expiresAt,
        payloadHash: loaded.payloadHash }, transaction: loaded.transaction, expected, holdsEnough });
    return finish(decision.allowed ? "allowed" : "rejected", decision.reason);
  } catch (error) {
    console.error("Wrap chain revalidation failed for intent:", loaded.intentId, error);
    return finish("rejected", "CHAIN_REVALIDATION_FAILED");
  }
}
