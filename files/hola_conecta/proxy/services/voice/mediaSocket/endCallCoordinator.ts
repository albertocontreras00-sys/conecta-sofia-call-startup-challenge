import { WebSocket } from 'ws';
import { logError, logInfo } from '../../../utils/logger.js';
import type { VoiceSession } from '../voiceSessionTypes.ts';

export type MediaSocketEndCallCoordinator = {
  clearHangupTimer: () => void;
  closeCallAfterFinalAudio: (reason: string) => Promise<void>;
  getHangupState: () => { requested: boolean; reason: string | null };
  requestEndCall: (reason: string, toolCallId: string | null) => void;
};

export function createMediaSocketEndCallCoordinator(input: {
  emitLocalDebugEvent: (event: string, metadata?: Record<string, unknown>) => void;
  fallbackDelayMs: number;
  flushOutboundQueue: () => Promise<void>;
  getClosed: () => boolean;
  getSession: () => VoiceSession | null;
  logContext: string;
  productionTraceMetadata: () => Record<string, unknown>;
  closeProviderCall: (reason: string) => Promise<void>;
  requestOutboundTurnFlush: () => void;
  ws: WebSocket;
}): MediaSocketEndCallCoordinator {
  let hangupRequested = false;
  let hangupReason: string | null = null;
  let hangupTimer: NodeJS.Timeout | null = null;

  function clearHangupTimer(): void {
    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }
  }

  async function closeCallAfterFinalAudio(reason: string): Promise<void> {
    if (input.getClosed() || !hangupRequested) return;
    clearHangupTimer();
    try {
      input.requestOutboundTurnFlush();
      await input.flushOutboundQueue();
    } catch (error) {
      logError(input.logContext, 'voice.ws.end_call_flush_failed', error, {
        sessionId: input.getSession()?.sessionId || null,
        callId: input.getSession()?.callId || null,
        reason
      });
    }
    try {
      await input.closeProviderCall(reason);
    } catch (error) {
      logError(input.logContext, 'voice.ws.end_call_provider_hangup_failed', error, {
        sessionId: input.getSession()?.sessionId || null,
        callId: input.getSession()?.callId || null,
        reason
      });
    }
    if (input.ws.readyState === WebSocket.OPEN) {
      logInfo(input.logContext, 'voice.ws.end_call_closing', {
        ...input.productionTraceMetadata(),
        sessionId: input.getSession()?.sessionId || null,
        callId: input.getSession()?.callId || null,
        reason,
        requestedReason: hangupReason
      });
      input.ws.close(1000, 'Sofia completed the call');
    }
  }

  function requestEndCall(reason: string, toolCallId: string | null): void {
    if (hangupRequested) return;
    hangupRequested = true;
    hangupReason = reason;
    logInfo(input.logContext, 'voice.ws.end_call_requested', {
      ...input.productionTraceMetadata(),
      sessionId: input.getSession()?.sessionId || null,
      callId: input.getSession()?.callId || null,
      toolCallId,
      reason,
      fallbackDelayMs: input.fallbackDelayMs
    });
    input.emitLocalDebugEvent('end_call_requested', {
      toolCallId,
      reason,
      fallbackDelayMs: input.fallbackDelayMs
    });
    hangupTimer = setTimeout(() => {
      void closeCallAfterFinalAudio('end_call_fallback_timeout');
    }, input.fallbackDelayMs);
  }

  return {
    clearHangupTimer,
    closeCallAfterFinalAudio,
    getHangupState: () => ({ requested: hangupRequested, reason: hangupReason }),
    requestEndCall
  };
}
