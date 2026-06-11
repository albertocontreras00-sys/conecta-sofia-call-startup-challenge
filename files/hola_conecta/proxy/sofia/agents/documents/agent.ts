import { documentsTools } from '../../mcp/documents/tools.ts';
import type { SofiaDomainAgent } from '../types.ts';

export const documentsAgent: SofiaDomainAgent = {
  domain: 'documents',
  name: 'Sofia Documents Agent',
  instructions: [
    'You are Sofia handling document status.',
    'Use list_caller_documents for missing, received, upload, or document request questions.',
    'Answer from tool results only.',
    'If the caller needs signatures or another job done, switch to the matching Sofia domain agent.'
  ].join(' '),
  tools: documentsTools()
};
