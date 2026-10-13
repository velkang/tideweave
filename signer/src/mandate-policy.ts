import type { MonadAutomation } from './monad-automation-policy';
import type { Hex } from "viem";

/** What the signer knows about a request the automation agent made. */
export type AutomationContext = {
  monad?: MonadAutomation;
  runId: string;
  /** null when the run no longer exists. */
  runStatus: string | null;
  /** null when the run's mandate no longer exists. `poolId`: a v4 pool id or a v3 pool address. */
  mandate: { status: string; poolId: Hex; maxPositionUsd: number; maxRunsPerDay: number } | null;
  /** Runs of this mandate started in the last 24 hours, this one included. */
  runsStartedToday: number;
};

