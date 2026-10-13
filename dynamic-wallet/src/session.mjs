// Dynamic's API-token login gives a session that expires, so a long-running service must log in again.

/** True when Dynamic rejected a request as unauthenticated. */
export function isUnauthorized(error) {
  if (!(error instanceof Error)) return false;
  return error.response?.status === 401 || error.status === 401 || /status code 401\b/.test(error.message);
}

/**
 * Runs Dynamic calls on a session that is renewed once it is `maxAgeMs` old, and renewed and retried
 * once when Dynamic answers 401 anyway. A 401 means the call did nothing, so retrying it is safe.
 */
export function createDynamicSession({ login, maxAgeMs, now = Date.now }) {
  let loggedInAt = null;
  let current = null;

  const renew = () => {
    current ??= login()
      .then(() => { loggedInAt = now(); })
      .finally(() => { current = null; });
    return current;
  };

  const fresh = async () => {
    if (loggedInAt === null || now() - loggedInAt >= maxAgeMs) await renew();
  };

  return {
    async run(call) {
      await fresh();
      try { return await call(); }
      catch (error) {
        if (!isUnauthorized(error)) throw error;
        loggedInAt = null;
        await renew();
        return call();
      }
    },
  };
}
