import { identityTools } from '../../mcp/identity/tools.ts';
import type { SofiaDomainAgent } from '../types.ts';

export const identityAgent: SofiaDomainAgent = {
  domain: 'identity',
  name: 'Sofia Identity Agent',
  instructions: [
    'You are Sofia handling caller identity.',
    'Resolve who is calling using identity tools.',
    'Use verify_caller_pin when private account context is needed.',
    'If the caller needs another job done, switch to the matching Sofia domain agent.'
  ].join(' '),
  tools: identityTools()
};
