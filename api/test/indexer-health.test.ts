import { describe, expect, it } from "vitest";
import {
  getIndexerHealth,
  type DiscoveryCheckpoint,
  type IndexerHealthStore,
} from "../src/indexer-health";

const freshDiscovery = [
  { name: "monad-nadfun_pools_created", blockNumber: 500, updatedAt: 2_900 },
  { name: "monad-v4_pools_created", blockNumber: 500, updatedAt: 2_900 },
  { name: "monad-v3_pools_created", blockNumber: 500, updatedAt: 2_900 },
];

function store(checkpoints: DiscoveryCheckpoint[] = freshDiscovery) {
  return { discoveryCheckpoints: async () => checkpoints } satisfies IndexerHealthStore;
}

describe("indexer health", () => {
  it("is healthy while both discovery positions were saved recently", async () => {
    const health = await getIndexerHealth(store(), { now: () => 3_000 });

    expect(health.httpStatus).toBe(200);
    expect(health.body).toEqual({
      status: "healthy",
      discovery: { nadfun: { blockNumber: 500, ageMs: 100 }, v4: { blockNumber: 500, ageMs: 100 }, v3: { blockNumber: 500, ageMs: 100 } },
    });
  });

  it("tolerates the minute between position saves", async () => {
    const health = await getIndexerHealth(store(), { now: () => 2_900 + 90_000 });
    expect(health.body.status).toBe("healthy");
  });

  it("is stale when live pool discovery falls behind, so new pools would be missing", async () => {
    const missing = await getIndexerHealth(store([freshDiscovery[1]]), { now: () => 3_000 });
    expect(missing.httpStatus).toBe(503);
    expect(missing.body).toMatchObject({ status: "stale", discovery: { v3: null } });

    const lagging = await getIndexerHealth(store(), { now: () => 2_900 + 4 * 60_000 });
    expect(lagging.httpStatus).toBe(503);
    expect(lagging.body.status).toBe("stale");
  });

  it("reports an indexer that has never run", async () => {
    const health = await getIndexerHealth(store([]));

    expect(health).toEqual({
      httpStatus: 503,
      body: { status: "unavailable" },
    });
  });
});

for (const checkpoint of freshDiscovery) {
  it(`marks ${checkpoint.name} missing or stale`, async () => {
    expect((await getIndexerHealth(store(freshDiscovery.filter((row) => row !== checkpoint)),
      { now: () => 3000 })).httpStatus).toBe(503);
    expect((await getIndexerHealth(store(freshDiscovery.map((row) => row === checkpoint
      ? { ...row, updatedAt: 0 } : { ...row, updatedAt: 200_000 })),
      { now: () => 200_000 })).httpStatus).toBe(503);
  });
}
