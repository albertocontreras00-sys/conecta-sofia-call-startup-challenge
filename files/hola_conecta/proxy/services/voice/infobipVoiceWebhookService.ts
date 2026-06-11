import { logInfo } from '../../utils/logger.js';
import { parseInfobipVoiceWebhook, parseJsonObject, verifyInfobipVoiceRequest } from './voiceSchemas.ts';
import type { ParsedVoiceWebhook } from './voiceSchemas.ts';
import {
  createSofiaInteractionEnvelope,
  createSofiaWorkflowAuditEvent
} from '../../sofia/services/workflow/index.ts';
import { phoneLogSummary } from './voiceLogSanitizer.ts';
import { assertSofiaLiveReadiness } from './sofiaLiveReadiness.ts';
import { logJsonHandoff } from './sofiaVoiceJsonHandoffLogger.ts';
import { archiveInfobipVoiceRecordingEvent } from '../phone/infobipVoiceRecordingArchiveService.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent
} from '../phone/phoneJsonContract.ts';
import { logPriorityLifecycleWebhookShape } from './webhook/lifecycleWebhookShapeLogger.ts';
import { emitSofiaVoiceStartupVokerEvent } from './webhook/startupVokerObservability.ts';
import { handleInfobipProviderCallback } from './webhook/providerCallbackHandler.ts';
import { handleNonCallReceivedWebhookEvent } from './webhook/nonCallReceivedHandler.ts';
import { resolveCallReceivedRoute } from './webhook/routeLookup.ts';
import { createInboundCallLogForCallReceived } from './webhook/callLogStartup.ts';
import { startInfobipConferenceForCallReceived } from './webhook/conferenceStartup.ts';
import { logInfobipVoiceWebhookFailure } from './webhook/webhookFailureHandler.ts';

export { buildInfobipDialogCustomDataForCallReceived } from './webhook/dialogCustomData.ts';
export { emitSofiaVoiceStartupVokerEvent } from './webhook/startupVokerObservability.ts';

const LOG_CONTEXT = 'infobipVoiceWebhookService';

export async function processInfobipVoiceWebhook(input: {
  raw: Buffer;
  req: Parameters<typeof verifyInfobipVoiceRequest>[0];
  transactionId: string | null;
}): Promise<{ handled: boolean; action: string; eventType: string; callId: string; dialogId?: string | null; orgId?: string | null }> {
  const startedAt = Date.now();
  let parsed: ParsedVoiceWebhook | null = null;

  try {
    logInfo(LOG_CONTEXT, 'voice.webhook.received', {
      transactionId: input.transactionId,
      payloadBytes: input.raw.length
    });
    emitSofiaVoiceStartupVokerEvent({
      eventName: 'infobip_voice_event_received',
      outcome: 'success',
      payloadBytes: input.raw.length
    });
    logPhoneJsonEvent('voice.json.provider_event.received', buildPhoneJsonEnvelope({
      eventType: 'provider_event.received',
      source: {
        sender: 'infobip',
        converter: 'infobipVoiceWebhookService',
        receiver: 'voice webhook signature verifier',
        transport: 'http',
        provider_event_type: null,
        provider_payload_shape: 'internal'
      },
      metadata: {
        transaction_id: input.transactionId,
        payload_bytes: input.raw.length
      }
    }));
    logJsonHandoff({
      logContext: LOG_CONTEXT,
      event: 'voice.json.infobip_webhook.sender_to_converter',
      sender: 'infobip',
      converter: 'infobipVoiceWebhookService / voiceSchemas',
      receiver: 'sofia voice webhook parser',
      direction: 'sender_to_converter',
      stage: 'raw_webhook_received',
      status: 'received',
      provider: 'infobip',
      payloadBytes: input.raw.length,
      metadata: {
        transactionId: input.transactionId
      }
    });

    const signature = verifyInfobipVoiceRequest(input.req, input.raw);
    logPhoneJsonEvent('voice.json.provider_event.signature_verified', buildPhoneJsonEnvelope({
      eventType: 'provider_event.signature_verified',
      source: {
        sender: 'infobip',
        converter: 'voiceSchemas.verifyInfobipVoiceRequest',
        receiver: 'infobipVoiceWebhookService',
        transport: 'http',
        provider_event_type: null,
        provider_payload_shape: 'internal'
      },
      metadata: {
        transaction_id: input.transactionId,
        payload_bytes: input.raw.length,
        reason: signature.reason
      }
    }));
    logInfo(LOG_CONTEXT, 'voice.webhook.signature_verified', {
      transactionId: input.transactionId,
      payloadBytes: input.raw.length,
      reason: signature.reason
    });
    logInfo(LOG_CONTEXT, 'voice.webhook.verified', {
      transactionId: input.transactionId,
      payloadBytes: input.raw.length,
      reason: signature.reason
    });

    const providerBody = parseJsonObject(input.raw, 'Infobip voice provider event payload');
    logPriorityLifecycleWebhookShape(providerBody, input.transactionId, input.raw.length);
    const recordingArchiveResult = await archiveInfobipVoiceRecordingEvent(providerBody);
    if (recordingArchiveResult.handled) {
      return {
        handled: true,
        action: recordingArchiveResult.action,
        eventType: 'CONFERENCE_RECORDING_READY',
        callId: recordingArchiveResult.providerFileId || 'unknown',
        dialogId: null,
        orgId: recordingArchiveResult.orgId
      };
    }

    const providerCallbackResult = await handleInfobipProviderCallback({
      providerBody,
      payloadBytes: input.raw.length,
      transactionId: input.transactionId
    });
    if (providerCallbackResult) return providerCallbackResult;

    parsed = parseInfobipVoiceWebhook(input.raw, input.transactionId);
    logInfo(LOG_CONTEXT, 'voice.webhook.body_parsed', {
      callId: parsed.event.callId,
      dialogId: parsed.event.dialogId,
      eventType: parsed.event.eventType,
      orgId: parsed.event.orgId,
      ...phoneLogSummary(parsed.event.fromPhone, 'from'),
      ...phoneLogSummary(parsed.event.toPhone, 'to'),
      transactionId: input.transactionId,
      payloadBytes: parsed.payloadBytes
    });

    const event = parsed.event;
    const skippedEventResult = handleNonCallReceivedWebhookEvent({
      logContext: LOG_CONTEXT,
      parsed,
      startedAt,
      transactionId: input.transactionId
    });
    if (skippedEventResult) return skippedEventResult;

    const route = await resolveCallReceivedRoute({
      logContext: LOG_CONTEXT,
      parsed,
      transactionId: input.transactionId
    });
    const { orgId, routeResolution } = route;
    const inboundCallLog = await createInboundCallLogForCallReceived({
      logContext: LOG_CONTEXT,
      parsed,
      route,
      transactionId: input.transactionId
    });

    const webhookEnvelope = createSofiaInteractionEnvelope({
      orgId,
      channel: 'voice',
      inputText: '[redacted_voice_webhook_event]',
      interactionId: event.callId,
      sessionId: event.dialogId || event.callId,
      turnId: event.callId,
      requestId: input.transactionId || event.callId,
      receivedAt: new Date(),
      metadata: {
        entryPoint: 'voice_webhook',
        actorType: 'contact',
        channel: 'voice'
      }
    });
    void createSofiaWorkflowAuditEvent({
      envelope: webhookEnvelope,
      eventType: 'voice_webhook_received',
      eventSummary: 'Voice webhook event received',
      metadata: {
        entryPoint: 'voice_webhook',
        channel: 'voice',
        status: 'received'
      }
    });
    logInfo(LOG_CONTEXT, 'voice.webhook.event_classified', {
      callId: event.callId,
      dialogId: event.dialogId,
      eventType: event.eventType,
      orgId,
      routeId: routeResolution.routeId,
      routeProvider: routeResolution.provider,
      ...phoneLogSummary(event.fromPhone, 'from'),
      ...phoneLogSummary(event.toPhone, 'to'),
      transactionId: input.transactionId
    });

    logInfo(LOG_CONTEXT, 'voice.webhook.org_resolved', {
      callId: event.callId,
      dialogId: event.dialogId,
      eventType: event.eventType,
      orgId,
      routeId: routeResolution.routeId,
      routeProvider: routeResolution.provider,
      transactionId: input.transactionId,
      ...phoneLogSummary(event.toPhone, 'to')
    });
    assertSofiaLiveReadiness({
      callId: event.callId,
      dialogId: event.dialogId,
      logContext: LOG_CONTEXT,
      orgId,
      phase: 'infobip_call_received_webhook',
      requireOrgResolution: true,
      transactionId: input.transactionId
    });

    const { conferenceId } = await startInfobipConferenceForCallReceived({
      inboundCallLog,
      logContext: LOG_CONTEXT,
      parsed,
      route,
      startedAt,
      transactionId: input.transactionId
    });
    logInfo(LOG_CONTEXT, 'voice.webhook.completed', {
      callId: event.callId,
      dialogId: conferenceId,
      eventType: event.eventType,
      orgId,
      transactionId: input.transactionId,
      durationMs: Date.now() - startedAt
    });

    return { handled: true, action: 'conference_created_with_websocket_endpoint', eventType: event.eventType, callId: event.callId, dialogId: conferenceId, orgId };
  } catch (error) {
    logInfobipVoiceWebhookFailure({
      error,
      logContext: LOG_CONTEXT,
      parsed,
      payloadBytes: input.raw.length,
      startedAt,
      transactionId: input.transactionId
    });
    throw error;
  }
}
