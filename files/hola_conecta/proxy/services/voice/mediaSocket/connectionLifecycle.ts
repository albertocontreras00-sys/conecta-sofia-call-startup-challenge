import { logError, logInfo } from '../../../utils/logger.js';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent
} from '../../phone/phoneJsonContract.ts';
import type { MediaSocketConnectionLifecycleOptions } from './runtimeTypes.ts';

export function bindMediaSocketConnectionLifecycle(options: MediaSocketConnectionLifecycleOptions): void {
  const {
    cleanup,
    correlationId,
    currentTurnId,
    emitFinalSummary,
    finalizeReceptionistCall,
    getSession,
    logAudioSummary,
    logContext,
    productionTraceMetadata,
    publishClosedLiveState,
    publishFailedLiveState,
    ws
  } = options;

  ws.on('pong', () => {
    const session = getSession();
    if (session) session.lastPongAt = Date.now();
  });

  ws.on('close', (code, reason) => {
    const session = getSession();
    const closeReason = reason.toString() || `ws_close_${code}`;
    logPhoneJsonEvent('voice.json.media_ws.closed', buildPhoneJsonEnvelope({
      eventType: 'media_ws.closed',
      orgId: session?.orgId || null,
      call: {
        provider_call_id: session?.callId || null,
        dialog_id: session?.dialogId || null,
        direction: 'inbound',
        from: session?.fromPhone || null,
        to: session?.toPhone || null,
        status: code === 1000 ? 'completed' : 'failed',
        duration_seconds: session ? Math.max(0, Math.round((Date.now() - session.startedAt) / 1000)) : null
      },
      actor: { type: 'provider' },
      source: {
        sender: 'infobip_media_websocket',
        converter: 'infobipMediaWebSocketService.closeHandler',
        receiver: 'sofiaPhoneCallFinalizerService',
        transport: 'websocket',
        provider_event_type: 'websocket_close',
        provider_payload_shape: 'media_ws'
      },
      metadata: {
        correlation_id: correlationId,
        close_code: code,
        close_reason: closeReason,
        inbound_audio_bytes: session?.inboundAudioBytes || 0,
        outbound_audio_bytes: session?.outboundAudioBytes || 0,
        raw_audio_logged: false
      }
    }));
    logAudioSummary('websocket_close', code, closeReason);
    logInfo(logContext, 'voice.ws.closed', {
      ...productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      code,
      reason: closeReason,
      correlationId,
      inboundAudioBytes: session?.inboundAudioBytes || 0,
      outboundAudioBytes: session?.outboundAudioBytes || 0
    });
    if (session) {
      emitFinalSummary({
        timestamp: new Date().toISOString(),
        turnId: currentTurnId()
      });
      publishClosedLiveState({ code });
    }
    void finalizeReceptionistCall(closeReason).catch((error) => {
      const currentSession = getSession();
      logError(logContext, 'voice.receptionist.finalize_failed', error, {
        sessionId: currentSession?.sessionId || null,
        callId: currentSession?.callId || null,
        reason: closeReason
      });
    }).finally(() => {
      cleanup(`ws_close_${code}`);
    });
  });

  ws.on('error', (error) => {
    const session = getSession();
    logAudioSummary('websocket_error', null, 'ws_error');
    logError(logContext, 'voice.ws.error', error, {
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      correlationId
    });
    if (session) {
      publishFailedLiveState();
    }
    void finalizeReceptionistCall('ws_error').finally(() => {
      cleanup('ws_error');
    });
  });
}

