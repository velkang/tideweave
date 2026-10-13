import assert from "node:assert/strict";
import { test } from "node:test";
import { createDynamicSession, isUnauthorized } from "../src/session.mjs";

const unauthorized = () => Object.assign(new Error("Request failed with status code 401"), { response: { status: 401 } });

function setup() {
  let clock = 0;
  const logins = [];
  const session = createDynamicSession({ login: async () => { logins.push(clock); }, maxAgeMs: 1_000, now: () => clock });
  return { session, logins, advance: (ms) => { clock += ms; } };
}

test("logs in before the first call and reuses the session while it is fresh", async () => {
  const { session, logins, advance } = setup();
  assert.equal(await session.run(async () => "signed"), "signed");
  advance(999);
  await session.run(async () => "again");
  assert.deepEqual(logins, [0]);
});

test("logs in again once the session is older than its limit", async () => {
  const { session, logins, advance } = setup();
  await session.run(async () => undefined);
  advance(1_000);
  await session.run(async () => undefined);
  assert.deepEqual(logins, [0, 1_000]);
});

test("logs in again and retries once when Dynamic answers 401", async () => {
  const { session, logins } = setup();
  let calls = 0;
  const result = await session.run(async () => { calls += 1; if (calls === 1) throw unauthorized(); return "signed"; });
  assert.equal(result, "signed");
  assert.equal(calls, 2);
  assert.equal(logins.length, 2);
});

test("does not retry a second 401 or any other error", async () => {
  const { session } = setup();
  let calls = 0;
  await assert.rejects(session.run(async () => { calls += 1; throw unauthorized(); }), /401/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(session.run(async () => { calls += 1; throw new Error("SIGNED_TRANSACTION_MISMATCH"); }),
    /MISMATCH/);
  assert.equal(calls, 1);
});

test("concurrent calls share one login", async () => {
  const { session, logins } = setup();
  await Promise.all([session.run(async () => 1), session.run(async () => 2)]);
  assert.equal(logins.length, 1);
});

test("a failed login is not cached", async () => {
  let attempts = 0;
  const session = createDynamicSession({ login: async () => { attempts += 1; if (attempts === 1) throw new Error("down"); },
    maxAgeMs: 1_000, now: () => 0 });
  await assert.rejects(session.run(async () => undefined), /down/);
  await session.run(async () => undefined);
  assert.equal(attempts, 2);
});

test("recognises a 401 by status or by the axios message", () => {
  assert.equal(isUnauthorized(unauthorized()), true);
  assert.equal(isUnauthorized(Object.assign(new Error("x"), { status: 401 })), true);
  assert.equal(isUnauthorized(new Error("Request failed with status code 401")), true);
  assert.equal(isUnauthorized(new Error("Request failed with status code 403")), false);
  assert.equal(isUnauthorized("401"), false);
});
