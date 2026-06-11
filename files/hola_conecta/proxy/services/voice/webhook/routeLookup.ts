import { evaluatePhoneRoutingDecision } from '../../phone/phoneOfficeHoursService.ts';
import { VoiceWebhookParseError } from '../voiceErrors.ts';
import type { ParsedVoiceWebhook } from '../voiceSchemas.ts';
import {
  resolveSofiaVoiceOrgIdByCalledNumber
} from '../sofiaVoiceNumberLookupService.ts';
import {
  buildInfobipDialogCustomDataForCallReceived,
  routeCallsConfigurationId
} from './dialogCustomData.ts';
import { emitSofiaVoiceStartupVokerEvent } from './startupVokerObservability.ts';

export type SofiaVoiceRouteLookupResult = {
  callsConfigurationId: string;
  conferenceCustomData: ReturnType<typeof buildInfobipDialogCustomDataForCallReceived>;
  orgId: string;
  routeResolution: Awaited<ReturnType<typeof resolveSofiaVoiceOrgIdByCalledNumber>>;
  routingDecision: ReturnType<typeof evaluatePhoneRoutingDecision>;
  websocketEndpointConfigId: string;
};

export async function resolveCallReceivedRoute(input: {
  logContext: string;
  parsed: ParsedVoiceWebhook;
  transactionId: string | null;
}): Promise<SofiaVoiceRouteLookupResult> {
  const event = input.parsed.event;
  const routeResolution = await resolveSofiaVoiceOrgIdByCalledNumber({
    toPhone: event.toPhone,
    provider: 'infobip',
    transactionId: input.transactionId,
    logContext: input.logContext,
    callId: event.callId,
    dialogId: event.dialogId
  });
  emitSofiaVoiceStartupVokerEvent({
    eventName: 'route_org_resolution_succeeded',
    outcome: 'success',
    orgId: routeResolution.orgId,
    callId: event.callId,
    sessionId: event.dialogId || null,
    providerEventType: event.eventType,
    routeFound: true,
    orgResolved: true,
    hasFromPhone: Boolean(event.fromPhone),
    hasToPhone: Boolean(event.toPhone),
    hasProviderCallId: Boolean(event.callId),
    payloadBytes: input.parsed.payloadBytes
  });
  const routingDecision = evaluatePhoneRoutingDecision({ metadata: routeResolution.metadata });
  const websocketEndpointConfigId = String(routeResolution.websocketEndpointConfigId || '').trim();
  if (!websocketEndpointConfigId) {
    throw new VoiceWebhookParseError('Sofia voice route websocket endpoint config id is required', {
      reason: 'missing_route_websocket_endpoint_config_id',
      routeId: routeResolution.routeId
    });
  }
  const callsConfigurationId = routeCallsConfigurationId(routeResolution.metadata);
  if (!callsConfigurationId) {
    throw new VoiceWebhookParseError('Sofia voice route Infobip Calls configuration id is required for conference startup', {
      reason: 'missing_route_calls_configuration_id',
      routeId: routeResolution.routeId
    });
  }
  const conferenceCustomData = buildInfobipDialogCustomDataForCallReceived({
    orgId: routeResolution.orgId,
    fromPhone: event.fromPhone,
    toPhone: event.toPhone,
    parentCallId: event.callId,
    routeId: routeResolution.routeId,
    routePhone: routeResolution.phoneE164,
    defaultLanguage: routeResolution.defaultLanguage
  });
  const orgId = routeResolution.orgId;
  emitSofiaVoiceStartupVokerEvent({
    eventName: 'conference_websocket_startup_requested',
    outcome: 'success',
    orgId,
    callId: event.callId,
    sessionId: event.dialogId || null,
    providerEventType: event.eventType,
    routeFound: true,
    orgResolved: true,
    hasFromPhone: Boolean(event.fromPhone),
    hasToPhone: Boolean(event.toPhone),
    hasProviderCallId: Boolean(event.callId),
    configIdPresent: Boolean(callsConfigurationId),
    websocketConfigPresent: Boolean(websocketEndpointConfigId),
    payloadBytes: input.parsed.payloadBytes
  });
  return {
    callsConfigurationId,
    conferenceCustomData,
    orgId,
    routeResolution,
    routingDecision,
    websocketEndpointConfigId
  };
}
