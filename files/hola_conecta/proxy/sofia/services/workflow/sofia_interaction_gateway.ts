import type {
  SofiaInteractionChannel,
  SofiaInteractionEnvelope,
  SofiaJsonObject
} from '../../shared/sofiaWorkflow.ts';

export interface SofiaInteractionGatewayInput {
  orgId: string;
  channel?: SofiaInteractionChannel | null;
  inputText: string;
  interactionId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  userId?: string | null;
  contactId?: string | null;
  phoneNumber?: string | null;
  language?: string | null;
  locale?: string | null;
  requestId?: string | null;
  receivedAt?: string | Date | null;
  metadata?: SofiaJsonObject;
}

function normalizeDate(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

export function createSofiaInteractionEnvelope(input: SofiaInteractionGatewayInput): SofiaInteractionEnvelope {
  return {
    orgId: input.orgId,
    channel: input.channel || 'unknown',
    inputText: input.inputText,
    interactionId: input.interactionId ?? null,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    userId: input.userId ?? null,
    contactId: input.contactId ?? null,
    phoneNumber: input.phoneNumber ?? null,
    language: input.language ?? null,
    locale: input.locale ?? null,
    requestId: input.requestId ?? null,
    receivedAt: normalizeDate(input.receivedAt),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  };
}
