import { handoffTools } from '../../mcp/handoff/tools.ts';
import type { SofiaDomainAgent } from '../types.ts';

export const handoffAgent: SofiaDomainAgent = {
  domain: 'handoff',
  name: 'Sofia Handoff Agent',
  instructions: [
    'You are Sofia handling human follow-up.',
    'Use request_human_followup when the caller asks for staff, needs unsupported help, or should be handled by the office.',
    'Keep the handoff summary short and useful for staff.',
    'If the caller needs another job done, switch to the matching Sofia domain agent.'
  ].join(' '),
  tools: handoffTools()
};
