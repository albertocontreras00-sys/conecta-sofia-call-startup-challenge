import { appointmentsAgent } from './appointments/agent.ts';
import { documentsAgent } from './documents/agent.ts';
import { handoffAgent } from './handoff/agent.ts';
import { identityAgent } from './identity/agent.ts';
import { profileAgent } from './profile/agent.ts';
import { signaturesAgent } from './signatures/agent.ts';
import { tasksAgent } from './tasks/agent.ts';
import type { SofiaAgentDomain, SofiaDomainAgent } from './types.ts';

export const sofiaDomainAgents: Record<SofiaAgentDomain, SofiaDomainAgent> = {
  identity: identityAgent,
  appointments: appointmentsAgent,
  profile: profileAgent,
  documents: documentsAgent,
  signatures: signaturesAgent,
  tasks: tasksAgent,
  handoff: handoffAgent
};

export function resolveSofiaAgentDomain(value: unknown): SofiaAgentDomain {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'bookings') return 'appointments';
  if (normalized === 'crm' || normalized === 'crm_identity') return 'profile';
  if (normalized === 'messaging') return 'tasks';
  if (normalized === 'general') return 'handoff';
  if (normalized in sofiaDomainAgents) return normalized as SofiaAgentDomain;
  return 'handoff';
}

export function getSofiaDomainAgent(value: unknown): SofiaDomainAgent {
  return sofiaDomainAgents[resolveSofiaAgentDomain(value)];
}
