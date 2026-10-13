import type { Context } from 'hono';
import type { AppEnvironment } from './env';

/** Check run boundaries before costly reads. Signing checks them again against persisted state. */
export function automationBoundary() {
  return async (context: Context<AppEnvironment>, next: () => Promise<void>) => {
    const path = new URL(context.req.url).pathname;
    const agent = context.get('agentRun');
    if (agent && path.includes('/pairs/')) {
      if (!path.includes(`/pairs/${agent.venue}/${agent.poolId}/`)) return context.json({ error: 'MANDATE_POOL_NOT_ALLOWED' }, 403);
    }
    const prepares = path.endsWith('/prepare') || path.endsWith('/quote');
    if (agent && prepares) {
      const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return context.json({ error: 'INVALID_REQUEST' }, 400);
      const pairId = body.pairId ?? body.poolId ?? body.poolAddress;
      if ((pairId !== undefined && String(pairId).toLowerCase() !== agent.poolId.toLowerCase()) ||
          (body.venue !== undefined && body.venue !== agent.venue) ||
          (body.tokenId !== undefined && body.tokenId !== agent.tokenId) ||
          (path.includes('/v3/') && agent.venue !== 'uniswap-v3') ||
          (path.includes('/v4/') && agent.venue !== 'uniswap-v4')) {
        return context.json({ error: 'MANDATE_POOL_OR_POSITION_NOT_ALLOWED' }, 403);
      }
      if (body.action !== undefined && body.action !== 'withdraw' && body.action !== 'collect') {
        return context.json({ error: 'MANDATE_ACTION_NOT_ALLOWED' }, 403);
      }
    }
    if (!agent && context.req.method === 'POST' && (path.endsWith('/prepare') || path.endsWith('/execute'))) {
      const running = await context.env.DB.prepare(`SELECT ar.id FROM automation_runs ar
        JOIN automation_mandates am ON am.id = ar.mandate_id JOIN managed_wallets mw ON mw.id = am.wallet_id
        WHERE mw.user_id = ?1 AND ar.status = 'running' LIMIT 1`).bind(context.get('user').id).first();
      if (running) return context.json({ error: 'AUTOMATION_RUNNING' }, 409);
    }
    return next();
  };
}
