import type { GeminiFunctionDeclaration } from '../../services/voice/infobipMediaWebSocketGeminiTypes.ts';

export type SofiaAgentDomain =
  | 'identity'
  | 'appointments'
  | 'profile'
  | 'documents'
  | 'signatures'
  | 'tasks'
  | 'handoff';

export type SofiaDomainAgent = {
  domain: SofiaAgentDomain;
  name: string;
  instructions: string;
  tools: GeminiFunctionDeclaration[];
};
