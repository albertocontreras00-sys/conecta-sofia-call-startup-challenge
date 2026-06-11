import { logInfo } from '../../../utils/logger.js';
import type { SofiaInteractionEnvelope } from '../../../sofia/shared/sofiaWorkflow.ts';
import {
  createSofiaWorkflowAuditEvent,
  startSofiaWorkflowSessionTrace
} from '../../../sofia/services/workflow/index.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent
} from '../../phone/phoneJsonContract.ts';
import { publishSofiaLiveCallState } from '../../phone/phoneLiveStateService.ts';
import { assertSofiaLiveReadiness } from '../sofiaLiveReadiness.ts';
import { buildSofiaVoiceDebugJsonDump } from '../sofiaVoiceDeepDebugLog.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../sofiaVoiceJsonHandoffLogger.ts';
import { phoneLogSummary } from '../voiceLogSanitizer.ts';
import { inferInfobipAudioEncoding } from '../voicePcmCodec.ts';
import { makeSessionFromHandshake } from '../sofiaVoiceInfobipFrameHelpers.ts';
import { voiceSessionManager } from '../voiceSessionManager.ts';
import type { InfobipControlMessage, VoiceSession } from '../voiceSessionTypes.ts';
import type { GeminiDomain } from '../infobipMediaWebSocketGeminiTypes.ts';
import type { SofiaVoiceResponseLanguage } from '../sofiaVoiceLanguage.ts';

export type InfobipStartHandler = (
  handshake: Extract<InfobipControlMessage, { type: 'connected' | 'start' }>
) => Promise<void>;

export type CreateInfobipStartHandlerInput = {
  applyOwnerTestOverride: () => void;
  connectToInitialGeminiDomain: (domain: GeminiDomain, sessionHistory: string) => void;
  correlationId: string;
  getCurrentSessionHistory: () => string;
  initialGeminiDomain: GeminiDomain;
  logContext: string;
  logLanguageStateUpdated: (source: string) => void;
  productionTraceMetadata: () => Record<string, unknown>;
  resolveInitialCallerIdentity: () => Promise<void>;
  resolveStartupBusinessKnowledgeContext: (session: VoiceSession) => Promise<string>;
  resolveStartupGreetingBusinessName: (session: VoiceSession) => Promise<string>;
  resolveStartupTemporalContext: (session: VoiceSession) => Promise<string>;
  sessionEnvelope: () => SofiaInteractionEnvelope | null;
  setCallTemporalContext: (value: string) => void;
  setBusinessKnowledgeContext: (value: string) => void;
  setGreetingBusinessName: (value: string) => void;
  setInfobipContentType: (value: string | null) => void;
  setResponseLanguage: (value: SofiaVoiceResponseLanguage) => void;
  setSession: (session: VoiceSession) => void;
  clearHandshakeTimer: () => void;
  wsReadyState: () => number;
};

export function createInfobipStartHandler(input: CreateInfobipStartHandlerInput): InfobipStartHandler {
  return async (handshake) => {
    input.clearHandshakeTimer();
    const infobipContentType = handshake.contentType || null;
    input.setInfobipContentType(infobipContentType);
    logInfo(input.logContext, 'voice.infobip.handshake.shape_dump', {
      correlationId: input.correlationId,
      handshakeDump: buildSofiaVoiceDebugJsonDump({
        label: 'infobip_media_websocket_handshake',
        value: handshake
      })
    });
    logJsonHandoff({
      logContext: input.logContext,
      event: 'voice.json.infobip_ws.handshake_sender_to_converter',
      sender: 'Infobip media WebSocket',
      converter: 'sofiaVoiceInfobipFrameHelpers / websocket frame parser',
      receiver: 'VoiceSession / Sofia live session',
      direction: 'sender_to_converter',
      stage: 'handshake_received',
      status: 'received',
      callId: handshake.type === 'connected' ? handshake.parentCallId || handshake.callId : handshake.callId,
      dialogId: handshake.dialogId,
      orgId: handshake.orgId,
      provider: 'infobip',
      payloadShape: buildJsonPayloadShape(handshake),
      metadata: {
        correlationId: input.correlationId,
        controlMessageType: handshake.type,
        contentType: handshake.contentType,
        ...phoneLogSummary(handshake.toPhone, 'to')
      }
    });
    logPhoneJsonEvent('voice.json.media_ws.connected', buildPhoneJsonEnvelope({
      eventType: 'media_ws.connected',
      orgId: handshake.orgId || null,
      call: {
        provider_call_id: handshake.type === 'connected' ? handshake.parentCallId || handshake.callId : handshake.callId,
        dialog_id: handshake.dialogId,
        parent_call_id: handshake.type === 'connected' ? handshake.parentCallId || null : null,
        direction: 'inbound',
        from: handshake.fromPhone,
        to: handshake.toPhone,
        status: 'answered'
      },
      actor: { type: 'provider' },
      source: {
        sender: 'infobip_media_websocket',
        converter: 'voiceSchemas.parseInfobipControlMessage',
        receiver: 'infobipMediaWebSocketService',
        transport: 'websocket',
        provider_event_type: handshake.type,
        provider_payload_shape: 'media_ws'
      },
      metadata: {
        correlation_id: input.correlationId,
        content_type: handshake.contentType || null
      }
    }));
    logInfo(input.logContext, 'voice.ws.handshake_received', {
      correlationId: input.correlationId,
      eventType: handshake.type,
      callId: handshake.type === 'connected' ? handshake.parentCallId || handshake.callId : handshake.callId,
      dialogId: handshake.dialogId,
      orgId: handshake.orgId,
      ...phoneLogSummary(handshake.fromPhone, 'from'),
      ...phoneLogSummary(handshake.toPhone, 'to'),
      contentType: handshake.contentType
    });

    const session = makeSessionFromHandshake(handshake, input.correlationId);
    input.setSession(session);
    input.setResponseLanguage(session.languageState.responseLanguage);
    session.wsReadyState = input.wsReadyState();
    assertSofiaLiveReadiness({
      callId: session.callId,
      dialogId: session.dialogId,
      logContext: input.logContext,
      orgId: session.orgId,
      phase: 'infobip_media_websocket_handshake',
      requireOrgResolution: true
    });
    logInfo(input.logContext, 'voice.ws.handshake.parsed', {
      ...input.productionTraceMetadata(),
      sessionId: session.sessionId,
      callId: session.callId,
      dialogId: session.dialogId,
      orgId: session.orgId,
      contentType: infobipContentType,
      sampleRateHertz: session.sampleRateHertz,
      frameBytes: session.frameBytes,
      audioEncoding: inferInfobipAudioEncoding(infobipContentType)
    });
    logJsonHandoff({
      logContext: input.logContext,
      event: 'voice.json.infobip_ws.handshake_converter_to_receiver',
      sender: 'sofiaVoiceInfobipFrameHelpers',
      converter: 'makeSessionFromHandshake',
      receiver: 'VoiceSession / Sofia live session',
      direction: 'converter_to_receiver',
      stage: 'voice_session_created_from_handshake',
      status: 'converted',
      sessionId: session.sessionId,
      callId: session.callId,
      dialogId: session.dialogId,
      orgId: session.orgId,
      provider: 'infobip',
      payloadShape: buildJsonPayloadShape({
        sessionId: session.sessionId,
        callId: session.callId,
        dialogId: session.dialogId,
        orgId: session.orgId,
        sampleRateHertz: session.sampleRateHertz,
        frameBytes: session.frameBytes
      }),
      metadata: {
        correlationId: input.correlationId,
        contentType: infobipContentType,
        audioEncoding: inferInfobipAudioEncoding(infobipContentType)
      }
    });
    logPhoneJsonEvent('voice.json.media_ws.session_created', buildPhoneJsonEnvelope({
      eventType: 'media_ws.session_created',
      orgId: session.orgId,
      call: {
        provider_call_id: session.callId,
        dialog_id: session.dialogId,
        direction: 'inbound',
        from: session.fromPhone,
        to: session.toPhone,
        status: 'answered'
      },
      actor: { type: 'system' },
      source: {
        sender: 'infobipMediaWebSocketService',
        converter: 'makeSessionFromHandshake',
        receiver: 'VoiceSession',
        transport: 'websocket',
        provider_event_type: handshake.type,
        provider_payload_shape: 'media_ws'
      },
      metadata: {
        correlation_id: input.correlationId,
        runtime_session_id: session.sessionId,
        sample_rate_hertz: session.sampleRateHertz,
        frame_bytes: session.frameBytes
      }
    }));
    const envelope = input.sessionEnvelope();
    if (envelope) {
      void startSofiaWorkflowSessionTrace({ envelope });
      void createSofiaWorkflowAuditEvent({
        envelope,
        eventType: 'interaction_started',
        eventSummary: 'Voice interaction started',
        metadata: {
          ...input.productionTraceMetadata(),
          entryPoint: 'voice',
          channel: 'voice',
          wsConnected: true,
          audioFormat: handshake.contentType || 'unknown',
          aiProvider: 'gemini_live'
        }
      });
      void createSofiaWorkflowAuditEvent({
        envelope,
        eventType: 'voice_ws_connected',
        eventSummary: 'Voice media websocket connected',
        metadata: {
          ...input.productionTraceMetadata(),
          entryPoint: 'voice',
          channel: 'voice',
          wsConnected: true,
          audioFormat: handshake.contentType || 'unknown',
          status: 'connected'
        }
      });
    }
    logInfo(input.logContext, 'voice.ws.handshake_validated', {
      ...input.productionTraceMetadata(),
      sessionId: session.sessionId,
      callId: session.callId,
      dialogId: session.dialogId,
      orgId: session.orgId,
      ...phoneLogSummary(session.fromPhone, 'from'),
      ...phoneLogSummary(session.toPhone, 'to'),
      sampleRateHertz: session.sampleRateHertz,
      frameBytes: session.frameBytes,
      audioEncoding: inferInfobipAudioEncoding(infobipContentType),
      correlationId: input.correlationId
    });
    logInfo(input.logContext, 'voice.ws.session.created', {
      ...input.productionTraceMetadata(),
      sessionId: session.sessionId,
      callId: session.callId,
      dialogId: session.dialogId,
      orgId: session.orgId,
      sampleRateHertz: session.sampleRateHertz,
      frameBytes: session.frameBytes,
      audioEncoding: inferInfobipAudioEncoding(infobipContentType)
    });
    input.logLanguageStateUpdated('org_default');
    input.applyOwnerTestOverride();
    logInfo(input.logContext, 'voice.session.created.shape_dump', {
      ...input.productionTraceMetadata(),
      sessionId: session.sessionId,
      callId: session.callId,
      sessionDump: buildSofiaVoiceDebugJsonDump({
        label: 'voice_session_created',
        value: session
      })
    });

    await input.resolveInitialCallerIdentity();
    input.setGreetingBusinessName(await input.resolveStartupGreetingBusinessName(session));
    input.setCallTemporalContext(await input.resolveStartupTemporalContext(session));
    input.setBusinessKnowledgeContext(await input.resolveStartupBusinessKnowledgeContext(session));
    input.connectToInitialGeminiDomain(input.initialGeminiDomain, input.getCurrentSessionHistory());
    voiceSessionManager.requireTransition(session, 'listening', 'websocket_handshake_validated');
    void publishSofiaLiveCallState({
      session,
      sofiaStatus: 'listening',
      currentSafeAction: 'none',
      lastSafeEventAt: new Date().toISOString(),
      projectionEventType: 'sofia_runtime_milestone',
    });
  };
}
