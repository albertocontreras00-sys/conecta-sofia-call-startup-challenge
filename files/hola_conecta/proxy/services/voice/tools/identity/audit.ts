import crypto from 'node:crypto';
import { createSofiaInteractionEvent } from '../../../../models/sofiaInteractionEventsModel.ts';
import type { SofiaJsonObject } from '../../../../sofia/shared/sofiaWorkflow.ts';
import type { JsonValue } from '../../../../types/json.ts';
import { createSofiaVoiceProductionTraceId } from '../../sofiaVoiceProductionTrace.ts';
import type { SofiaIdentityCrmVoiceToolContext } from './types.ts';
import { maskFieldValue } from './fieldValues.ts';
import { isPinVerified } from './identityResponses.ts';

export function auditMetadata(input: {
  context: SofiaIdentityCrmVoiceToolContext;
  contactId: string;
  fieldKey: string;
  action: string;
  oldValue?: JsonValue;
  newValue?: JsonValue;
  toolName: string;
}): SofiaJsonObject {
  const session = input.context.session;
  const identity = input.context.callerIdentity;
  const sofiaVoiceTraceId = session
    ? createSofiaVoiceProductionTraceId({
        orgId: session.orgId,
        callId: session.callId,
        sessionId: session.sessionId,
        correlationId: session.correlationId
      })
    : null;
  return {
    orgId: session?.orgId || identity?.orgId || '',
    contactId: input.contactId,
    fieldKey: input.fieldKey,
    action: input.action,
    oldValueMasked: maskFieldValue(input.fieldKey, input.oldValue ?? null),
    newValueMasked: maskFieldValue(input.fieldKey, input.newValue ?? null),
    callId: session?.callId || null,
    sessionId: session?.sessionId || null,
    sofiaVoiceTraceId,
    verifiedFactors: identity?.verifiedFactors || [],
    identityStatus: identity?.identityStatus || null,
    toolName: input.toolName
  };
}

export async function writeAudit(input: {
  context: SofiaIdentityCrmVoiceToolContext;
  contactId: string;
  fieldKey: string;
  action: string;
  oldValue?: JsonValue;
  newValue?: JsonValue;
  toolName: string;
  sensitivity?: 'low' | 'medium' | 'high' | 'restricted';
}): Promise<void> {
  const session = input.context.session;
  const identity = input.context.callerIdentity;
  if (!session) return;
  const metadata = auditMetadata(input);
  await createSofiaInteractionEvent({
    id: crypto.randomUUID(),
    orgId: session.orgId,
    traceId: session.correlationId || session.callId,
    sessionId: session.sessionId,
    entryPoint: 'voice',
    channel: 'voice',
    actorType: 'contact',
    contactId: input.contactId,
    eventType: `identity_crm.${input.action}`,
    eventSummary: `${input.toolName} ${input.action} ${input.fieldKey}`,
    metadata,
    sensitivity: input.sensitivity || (identity && isPinVerified(identity) ? 'medium' : 'low')
  });
}
