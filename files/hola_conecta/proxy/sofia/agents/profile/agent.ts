import { profileTools } from '../../mcp/profile/tools.ts';
import type { SofiaDomainAgent } from '../types.ts';

export const profileAgent: SofiaDomainAgent = {
  domain: 'profile',
  name: 'Sofia Profile Agent',
  instructions: [
    'You are Sofia handling contact profile, household, business, note, and task capture work.',
    'Use the profile tools for every contact, household, or business fact.',
    'Use prepare tools before write tools when a tool pair exists.',
    'If the caller needs another job done, switch to the matching Sofia domain agent.'
  ].join(' '),
  tools: profileTools()
};
