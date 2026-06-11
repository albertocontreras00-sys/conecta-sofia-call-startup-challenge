import {
  updateInboundPhoneCallLogDialog,
  upsertInboundPhoneCallLog
} from '../../../models/phoneOutboundCallLogModel.ts';
import type { JsonObject } from '../../../types/json.ts';
import { publishPhoneLiveCallFromCallLog } from '../../phone/phoneLiveStateService.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent,
  normalizePhoneCallStatus,
  sanitizePhoneJson
} from '../../phone/phoneJsonContract.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../sofiaVoiceJsonHandoffLogger.ts';
import { phoneLogSummary } from '../voiceLogSanitizer.ts';
import type { ParsedVoiceWebhook } from '../voiceSchemas.ts';
import type { SofiaVoiceRouteLookupResult } from './routeLookup.ts';

export type InboundCallLogRow = Awaited<ReturnType<typeof upsertInboundPhoneCallLog>>;

export async function createInboundCallLogForCallReceived(input: {
  logContext: string;
  parsed: ParsedVoiceWebhook;
  route: SofiaVoiceRouteLookupResult;
  transactionId: string | null;
}): Promise<InboundCallLogRow> {
  const event = input.parsed.event;
  const inboundCallLog = await upsertInboundPhoneCallLog({
    orgId: input.route.orgId,
    providerCallId: event.callId,
    dialogId: event.dialogId,
    parentCallId: event.callId,
    fromNumber: event.fromPhone || null,
    toNumber: event.toPhone || '',
    status: normalizePhoneCallStatus('initiated'),
    rawProviderResponse: sanitizePhoneJson({
      provider_payload: event.raw,
      sofia_route: {
        route_id: input.route.routeResolution.routeId,
        route_phone: input.route.routeResolution.phoneE164,
        default_language: input.route.routeResolution.defaultLanguage,
        routing_decision: input.route.routingDecision,
      },
    }) as JsonObject
  });
  await publishPhoneLiveCallFromCallLog({
    row: inboundCallLog,
    source: 'infobip',
    projectionEventType: 'infobip_inbound_webhook',
    writeAction: 'create',
    lastProviderEventAt: new Date().toISOString(),
  });
  logPhoneJsonEvent('voice.json.call_received.normalized', buildPhoneJsonEnvelope({
    eventType: 'call_received.normalized',
    orgId: input.route.orgId,
    call: {
      phone_call_log_id: inboundCallLog.id,
      provider_call_id: event.callId,
      dialog_id: event.dialogId,
      parent_call_id: event.callId,
      direction: 'inbound',
      from: event.fromPhone,
      to: event.toPhone,
      status: 'initiated',
      duration_seconds: null
    },
    actor: { type: 'provider' },
    source: {
      sender: 'infobip',
      converter: 'voiceSchemas.parseInfobipVoiceWebhook',
      receiver: 'phone_call_logs',
      transport: 'http',
      provider_event_type: event.eventType,
      provider_payload_shape: 'calls_api'
    },
    metadata: {
      transaction_id: input.transactionId,
      route_id: input.route.routeResolution.routeId,
      routing_decision: input.route.routingDecision
    }
  }));
  logPhoneJsonEvent('voice.json.conference.startup.request', buildPhoneJsonEnvelope({
    eventType: 'conference.startup.request',
    orgId: input.route.orgId,
    call: {
      phone_call_log_id: inboundCallLog.id,
      provider_call_id: event.callId,
      dialog_id: null,
      parent_call_id: event.callId,
      direction: 'inbound',
      from: event.fromPhone,
      to: event.toPhone,
      status: 'ringing'
    },
    actor: { type: 'sofia' },
    source: {
      sender: 'conecta_sofia_voice',
      converter: 'infobipVoiceWebhookService.conferenceStartupRequestBuilder',
      receiver: 'infobip_conference_calls_api',
      transport: 'http',
      provider_event_type: event.eventType,
      provider_payload_shape: 'calls_api'
    },
    metadata: {
      transaction_id: input.transactionId,
      websocket_endpoint_config_id_present: Boolean(input.route.websocketEndpointConfigId),
      calls_configuration_id_present: Boolean(input.route.callsConfigurationId)
    }
  }));
  logJsonHandoff({
    logContext: input.logContext,
    event: 'voice.json.infobip_webhook.converter_to_receiver',
    sender: 'voiceSchemas',
    converter: 'normalized voice webhook parser',
    receiver: 'sofiaVoiceNumberLookupService',
    direction: 'converter_to_receiver',
    stage: 'parsed_webhook_to_route_resolver',
    status: 'forwarded',
    callId: event.callId,
    dialogId: event.dialogId,
    orgId: input.route.orgId,
    provider: 'infobip',
    payloadShape: buildJsonPayloadShape(event.raw),
    payloadBytes: input.parsed.payloadBytes,
    metadata: {
      transactionId: input.transactionId,
      eventType: event.eventType,
      routeId: input.route.routeResolution.routeId,
      ...phoneLogSummary(event.toPhone, 'to')
    }
  });
  return inboundCallLog;
}

export async function publishUpdatedInboundCallLog(input: {
  inboundCallLogId: string;
  orgId: string;
  dialogId: string;
  parentCallId: string;
  rawProviderResponse: JsonObject;
}): Promise<Awaited<ReturnType<typeof updateInboundPhoneCallLogDialog>>> {
  const updatedInboundCallLog = await updateInboundPhoneCallLogDialog({
    id: input.inboundCallLogId,
    orgId: input.orgId,
    dialogId: input.dialogId,
    parentCallId: input.parentCallId,
    rawProviderResponse: input.rawProviderResponse
  });
  if (updatedInboundCallLog) {
    await publishPhoneLiveCallFromCallLog({
      row: updatedInboundCallLog,
      source: 'infobip',
      projectionEventType: 'infobip_inbound_webhook',
      writeAction: 'update',
      lastProviderEventAt: new Date().toISOString(),
    });
  }
  return updatedInboundCallLog;
}
