import { tasksTools } from '../../mcp/tasks/tools.ts';
import type { SofiaDomainAgent } from '../types.ts';

export const tasksAgent: SofiaDomainAgent = {
  domain: 'tasks',
  name: 'Sofia Tasks Agent',
  instructions: [
    'You are Sofia handling callback and task requests.',
    'Collect the callback or task details the caller gives.',
    'Use create_callback_task for callback requests.',
    'If the caller needs another job done, switch to the matching Sofia domain agent.'
  ].join(' '),
  tools: tasksTools()
};
