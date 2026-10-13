// The Workers free plan allows five cron triggers per account, so the indexer uses one, every minute, and picks
// its jobs by the minute. The two heavy jobs never share a minute, so each keeps an invocation's CPU budget to itself.

export type IndexerJob = "discovery" | "refresh" | "expire";

/** The jobs for the cron run scheduled at `scheduledTime` (ms since the epoch, UTC). */
export function jobsAt(scheduledTime: number): IndexerJob[] {
  const minute = new Date(scheduledTime).getUTCMinutes();
  const jobs: IndexerJob[] = ["discovery"];
  // Refresh pool state at minutes 2, 7, 12, …; expire unconfirmed intents at 0, 5, 10, ….
  if (minute % 5 === 2) jobs.push("refresh");
  if (minute % 5 === 0) jobs.push("expire");
  return jobs;
}
