import { emitConectaVokerEvent } from '../observability/vokerObservabilityService.ts';
import { logInfo, logWarn } from '../../utils/logger.js';
import { buildSofiaVoiceVokerEvent } from './observability/vokerEventBuilder.ts';
import {
  hasVokerVoiceCompletedTextTurn,
  recordVokerVoiceTranscriptMessage,
  resetVokerVoiceMessageAccumulatorForTests as resetVokerVoiceMessageAccumulatorStateForTests
} from './observability/vokerMessageAccumulator.ts';
export { emitSofiaVoiceFinalSummaryVokerEvent } from './observability/vokerFinalSummary.ts';
export type {
  SofiaVoiceObservabilityPayload,
  SofiaVoiceTranscriptDirection,
  SofiaVoiceTranscriptEvent
} from './observability/vokerTranscriptTypes.ts';
export {
  recordVokerVoiceToolCall,
  recordVokerVoiceToolResult
} from './observability/vokerMessageAccumulator.ts';
import {
  redactVoiceTranscriptText
} from './voiceTranscriptRedactionService.ts';
import type { SofiaVoiceObservabilityPayload, SofiaVoiceTranscriptEvent } from './observability/vokerTranscriptTypes.ts';

const LOG_CONTEXT = 'sofiaVoiceObservabilityPayloadService';

type QueuedSofiaAssistantTranscript = {
  event: SofiaVoiceTranscriptEvent;
  transcriptText: string;
  chunkCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
};

const queuedSofiaAssistantTranscripts = new Map<string, QueuedSofiaAssistantTranscript>();

function mergeTranscriptText(existingText: string, nextText: string): string {
  const existing = existingText.trim();
  const next = nextText.trim();
  if (!next) return existing;
  if (!existing) return next;
  if (next === existing || existing.endsWith(next)) return existing;
  if (next.startsWith(existing)) return next;
  return `${existing} ${next}`.replace(/\s+([,.;:!?])/g, '$1');
}

export function queueSofiaVoiceAssistantTranscriptForVoker(event: SofiaVoiceTranscriptEvent): void {
  if (event.direction !== 'sofia') {
    emitSofiaVoiceObservabilityPayload(event);
    return;
  }
  const transcriptText = event.transcriptText.trim();
  if (!transcriptText) {
    emitSofiaVoiceObservabilityPayload(event);
    return;
  }
  const existing = queuedSofiaAssistantTranscripts.get(event.callId);
  if (!existing) {
    queuedSofiaAssistantTranscripts.set(event.callId, {
      event,
      transcriptText,
      chunkCount: 1,
      firstTimestamp: event.timestamp,
      lastTimestamp: event.timestamp
    });
    return;
  }
  queuedSofiaAssistantTranscripts.set(event.callId, {
    event,
    transcriptText: mergeTranscriptText(existing.transcriptText, transcriptText),
    chunkCount: existing.chunkCount + 1,
    firstTimestamp: existing.firstTimestamp,
    lastTimestamp: event.timestamp
  });
}

export function flushQueuedSofiaVoiceAssistantTranscriptForVoker(input: {
  callId: string;
  reason: string;
}): boolean {
  const queued = queuedSofiaAssistantTranscripts.get(input.callId);
  if (!queued) return false;
  queuedSofiaAssistantTranscripts.delete(input.callId);
  if (!queued.transcriptText.trim()) return false;
  const event: SofiaVoiceTranscriptEvent = {
    ...queued.event,
    transcriptText: queued.transcriptText,
    timestamp: queued.lastTimestamp,
    toolMetadata: {
      ...(queued.event.toolMetadata || {}),
      vokerFlushReason: input.reason,
      transcriptChunkCount: queued.chunkCount,
      firstTranscriptTimestamp: queued.firstTimestamp,
      lastTranscriptTimestamp: queued.lastTimestamp
    }
  };
  logInfo(LOG_CONTEXT, 'voker.voice_assistant_transcript_flushed', {
    orgId: event.orgId,
    callId: event.callId,
    sessionId: event.sessionId,
    turnId: event.turnId || null,
    reason: input.reason,
    transcriptChunkCount: queued.chunkCount,
    transcriptChars: queued.transcriptText.length
  });
  emitSofiaVoiceObservabilityPayload(event);
  return true;
}

export function buildSofiaVoiceObservabilityPayload(
  event: SofiaVoiceTranscriptEvent
): SofiaVoiceObservabilityPayload {
  const redaction = redactVoiceTranscriptText(event.transcriptText);
  return {
    orgId: event.orgId,
    callId: event.callId,
    sessionId: event.sessionId,
    turnId: event.turnId || null,
    direction: event.direction,
    sanitizedTranscript: redaction.redactedText,
    redactionCounts: redaction.redactionCounts,
    hasRedactions: redaction.hasRedactions,
    transcriptSource: event.source,
    eventTimestamp: event.timestamp,
    providerEventId: event.providerEventId || null,
    language: event.language || null,
    pipeline: {
      provider: 'infobip',
      agent: 'sofia',
      channel: 'voice',
      modelName: event.modelName || null,
      latencyMs: typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs) ? event.latencyMs : null,
      toolMetadata: event.toolMetadata || null
    }
  };
}

export function emitSofiaVoiceObservabilityPayload(event: SofiaVoiceTranscriptEvent): void {
  const transcriptLength = event.transcriptText.trim().length;
  if (transcriptLength === 0) {
    logWarn(LOG_CONTEXT, 'voker.voice_transcript_event_skipped', {
      reason: 'missing_transcript_text',
      orgId: event.orgId,
      callId: event.callId,
      sessionId: event.sessionId,
      turnId: event.turnId || null,
      direction: event.direction,
      transcriptChars: transcriptLength,
      userChars: event.direction === 'caller' ? transcriptLength : 0,
      assistantChars: event.direction === 'sofia' ? transcriptLength : 0,
      messageCount: 0
    });
    return;
  }
  const accumulated = recordVokerVoiceTranscriptMessage({
    callId: event.callId,
    direction: event.direction,
    transcriptText: event.transcriptText
  });
  if (event.direction !== 'sofia') return;
  if (!hasVokerVoiceCompletedTextTurn(accumulated.messages)) {
    logWarn(LOG_CONTEXT, 'voker.voice_transcript_event_skipped', {
      reason: 'completed_turn_text_missing',
      orgId: event.orgId,
      callId: event.callId,
      sessionId: event.sessionId,
      turnId: event.turnId || null,
      direction: event.direction,
      transcriptChars: transcriptLength,
      userChars: 0,
      assistantChars: transcriptLength,
      messageCount: accumulated.messages.length
    });
    return;
  }
  emitConectaVokerEvent(buildSofiaVoiceVokerEvent({
    event,
    messages: accumulated.messages,
    outputMessage: accumulated.outputMessage,
    cumulativeRedaction: accumulated.cumulativeRedaction
  }));
}

export function resetVokerVoiceMessageAccumulatorForTests(): void {
  queuedSofiaAssistantTranscripts.clear();
  resetVokerVoiceMessageAccumulatorStateForTests();
}
