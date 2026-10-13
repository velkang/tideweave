import { request, post } from './api-client'
export type AutomationVenue = 'uniswap-v3' | 'uniswap-v4'
export type Band = 'wide' | 'balanced' | 'narrow'
export type Mandate = { id: string; venue: AutomationVenue; tokenId: string; poolId: string; mode: 'ask' | 'autopilot';
  status: 'active' | 'paused'; band: Band | 'agent'; maxPositionUsd: number; maxRunsPerDay: number }
export type AutomationRun = { id: string; mandateId: string; venue: AutomationVenue; tokenId: string; poolId: string;
  kind: 'rebalance' | 'close'; status: 'proposed' | 'running' | 'done' | 'failed' | 'declined' | 'expired';
  reason?: string; failureReason?: string; state?: { done?: string[]; pending?: { attemptId?: string; transactionHash?: string; intentId: string } } }
export const automationApi = {
  eligibility: (venue: AutomationVenue, pairId: string, tokenId: string) => request<{ eligible: true; valueUsd: number }>(
    `/v1/automation/eligibility?venue=${venue}&pairId=${encodeURIComponent(pairId)}&tokenId=${tokenId}`),
  mandates: () => request<{ mandates: Mandate[] }>('/v1/automation/mandates'),
  runs: () => request<{ runs: AutomationRun[] }>('/v1/automation/runs'),
  save: (body: Omit<Mandate, 'id' | 'poolId'> & { pairId: string }) => request<{ mandate: Mandate }>('/v1/automation/mandates',
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  revoke: (id: string) => request(`/v1/automation/mandates/${id}`, { method: 'DELETE' }),
  rebalance: (venue: AutomationVenue, pairId: string, tokenId: string, band: Band) =>
    post('/v1/automation/runs', { venue, pairId, tokenId, band }),
  approve: (id: string) => post(`/v1/automation/runs/${id}/approve`, {}),
  decline: (id: string) => post(`/v1/automation/runs/${id}/decline`, {}),
}
