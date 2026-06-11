import { logInfo } from '../../../utils/logger.js';
import type { JsonObject } from '../../../types/json.ts';
import {
  addExistingCallToInfobipConference,
  addWebSocketCallToInfobipConference,
  answerInfobipCall,
  createInfobipConference,
} from '../infobipCallsApiService.ts';
import { VoiceWebhookParseError } from '../voiceErrors.ts';
import type { ParsedVoiceWebhook } from '../voiceSchemas.ts';
import { phoneLogSummary } from '../voiceLogSanitizer.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../sofiaVoiceJsonHandoffLogger.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent,
  sanitizePhoneJson
} from '../../phone/phoneJsonContract.ts';
import {
  publishUpdatedInboundCallLog,
  type InboundCallLogRow
} from './callLogStartup.ts';
import type { SofiaVoiceRouteLookupResult } from './routeLookup.ts';

export async function startInfobipConferenceForCallReceived(input: {
  inboundCallLog: InboundCallLogRow;
  logContext: string;
  parsed: ParsedVoiceWebhook;
  route: SofiaVoiceRouteLookupResult;
  startedAt: number;
  transactionId: string | null;
}): Promise<{ conferenceId: string }> {
  const event = input.parsed.event;
  const {
    callsConfigurationId,
    conferenceCustomData,
    orgId,
    routeResolution,
    websocketEndpointConfigId
  } = input.route;

  const callerAnswer = await answerInfobipCall({
    callId: event.callId,
    customData: {
      source: 'sofia-voice-caller',
      orgId,
      parentCallId: event.callId,
      routeId: routeResolution.routeId,
      routePhone: routeResolution.phoneE164,
      defaultLanguage: routeResolution.defaultLanguage || ''
    }
  });
  logInfo(input.logContext, 'voice.webhook.conference_startup.started', {
    callId: event.callId,
    eventType: event.eventType,
    orgId,
    ...phoneLogSummary(event.fromPhone, 'from'),
    ...phoneLogSummary(event.toPhone, 'to'),
    transactionId: input.transactionId,
    websocketEndpointConfigId,
    callsConfigurationId
  });
  logInfo(input.logContext, 'voice.conference.startup_requested', {
    callId: event.callId,
    eventType: event.eventType,
    orgId,
    ...phoneLogSummary(event.fromPhone, 'from'),
    ...phoneLogSummary(event.toPhone, 'to'),
    transactionId: input.transactionId,
    websocketEndpointConfigId,
    callsConfigurationId
  });

  const conferenceStartupStartedAt = Date.now();
  logJsonHandoff({
    logContext: input.logContext,
    event: 'voice.json.infobip_conference.sender_to_receiver',
    sender: 'Conecta Sofia voice service',
    converter: 'Infobip conference startup request builder',
    receiver: 'Infobip Conference Calls API',
    direction: 'sender_to_receiver',
    stage: 'conference_create_request',
    status: 'sent',
    callId: event.callId,
    dialogId: null,
    orgId,
    provider: 'infobip',
    payloadShape: buildJsonPayloadShape({
      name: `sofia-${event.callId.slice(-12)}`,
      callsConfigurationId,
      existingCallId: event.callId,
      websocketEndpointConfigId,
      answeredCallId: event.callId
    }),
    metadata: {
      transactionId: input.transactionId,
      customDataKeys: Object.keys(conferenceCustomData).sort(),
      websocketEndpointConfigIdPresent: Boolean(websocketEndpointConfigId),
      callerAnswerResponseKeys: Object.keys(callerAnswer).sort()
    }
  });
  const conference = await createInfobipConference({
    name: `sofia-${event.callId.slice(-12)}`,
    callsConfigurationId
  });

  const conferenceId = typeof conference.id === 'string'
    ? conference.id
    : typeof conference.conferenceId === 'string'
      ? conference.conferenceId
      : null;
  if (!conferenceId) {
    throw new VoiceWebhookParseError('Infobip Sofia startup conference response did not include a conference id', {
      reason: 'conference_id_missing',
      routeId: routeResolution.routeId
    });
  }
  const websocketCustomData = {
    ...conferenceCustomData,
    dialogId: conferenceId,
    conferenceId
  };
  const callerParticipant = await addExistingCallToInfobipConference({
    conferenceId,
    callId: event.callId,
    customData: {
      source: 'sofia-voice-caller',
      orgId,
      parentCallId: event.callId,
      routeId: routeResolution.routeId,
      participantRole: 'caller'
    }
  });
  const sofiaParticipant = await addWebSocketCallToInfobipConference({
    conferenceId,
    websocketEndpointConfigId,
    identifier: `sofia-${event.callId.slice(-8)}`,
    customData: websocketCustomData
  });

  const updatedInboundCallLog = await publishUpdatedInboundCallLog({
    inboundCallLogId: input.inboundCallLog.id,
    orgId,
    dialogId: conferenceId,
    parentCallId: event.callId,
    rawProviderResponse: sanitizePhoneJson({
      callerAnswer,
      conference,
      callerParticipant,
      sofiaParticipant
    }) as JsonObject
  });
  if (!updatedInboundCallLog) {
    logPhoneJsonEvent('voice.json.conference.startup.call_log_update_failed', buildPhoneJsonEnvelope({
      eventType: 'conference.startup.call_log_update_failed',
      orgId,
      call: {
        phone_call_log_id: input.inboundCallLog.id,
        provider_call_id: event.callId,
        dialog_id: conferenceId,
        parent_call_id: event.callId,
        direction: 'inbound',
        from: event.fromPhone,
        to: event.toPhone,
        status: 'failed'
      },
      actor: { type: 'system' },
      source: {
        sender: 'infobipVoiceWebhookService.conferenceStartupResponseParser',
        converter: 'phoneOutboundCallLogModel.updateInboundPhoneCallLogDialog',
        receiver: 'phone_call_logs',
        transport: 'internal_service',
        provider_event_type: event.eventType,
        provider_payload_shape: 'calls_api'
      },
      metadata: {
        zero_rows_updated: true,
        response_keys: Object.keys(conference).sort()
      }
    }));
  }
  logPhoneJsonEvent('voice.json.conference.startup.response', buildPhoneJsonEnvelope({
    eventType: 'conference.startup.response',
    orgId,
    call: {
      phone_call_log_id: input.inboundCallLog.id,
      provider_call_id: event.callId,
      dialog_id: conferenceId,
      parent_call_id: event.callId,
      direction: 'inbound',
      from: event.fromPhone,
      to: event.toPhone,
      status: 'answered'
    },
    actor: { type: 'provider' },
    source: {
      sender: 'infobip_conference_calls_api',
      converter: 'infobipVoiceWebhookService.conferenceStartupResponseParser',
      receiver: 'conecta_sofia_voice',
      transport: 'http',
      provider_event_type: event.eventType,
      provider_payload_shape: 'calls_api'
    },
    metadata: {
      transaction_id: input.transactionId,
      duration_ms: Date.now() - conferenceStartupStartedAt,
      conference_id: conferenceId,
      response_json: sanitizePhoneJson({
        conference,
        callerParticipant,
        sofiaParticipant
      })
    }
  }));
  logJsonHandoff({
    logContext: input.logContext,
    event: 'voice.json.infobip_conference.receiver_response',
    sender: 'Infobip Conference Calls API',
    converter: 'Infobip conference startup response parser',
    receiver: 'Conecta Sofia voice service',
    direction: 'receiver_response',
    stage: 'conference_startup_response',
    status: 'accepted',
    callId: event.callId,
    dialogId: conferenceId,
    orgId,
    provider: 'infobip',
    payloadShape: buildJsonPayloadShape({
      conference,
      callerParticipant,
      sofiaParticipant
    }),
    durationMs: Date.now() - conferenceStartupStartedAt,
    metadata: {
      transactionId: input.transactionId,
      responseStatus: 'ok',
      responseKeys: Object.keys(conference).sort()
    }
  });
  logInfo(input.logContext, 'voice.webhook.conference_startup.success', {
    callId: event.callId,
    dialogId: conferenceId,
    eventType: event.eventType,
    orgId,
    ...phoneLogSummary(event.fromPhone, 'from'),
    ...phoneLogSummary(event.toPhone, 'to'),
    transactionId: input.transactionId,
    durationMs: Date.now() - input.startedAt
  });
  logInfo(input.logContext, 'voice.conference.startup_succeeded', {
    callId: event.callId,
    dialogId: conferenceId,
    eventType: event.eventType,
    orgId,
    ...phoneLogSummary(event.fromPhone, 'from'),
    ...phoneLogSummary(event.toPhone, 'to'),
    transactionId: input.transactionId,
    durationMs: Date.now() - input.startedAt
  });

  return { conferenceId };
}
