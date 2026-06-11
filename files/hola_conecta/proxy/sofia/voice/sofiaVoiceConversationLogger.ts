import { upsertSofiaVoiceConversationTurn, type SofiaVoiceConversationTurnKind } from '../../models/sofiaVoiceConversationTurnsModel.ts';
import { logError, logInfo } from '../../utils/logger.js';

type ConversationLogInput = {
  orgId: string;
  callId: string;
  sessionId: string;
  turnId?: string | null;
  turnNumber: number;
  turnKind: SofiaVoiceConversationTurnKind;
  callerTranscript?: string | null;
  sofiaResponseText?: string | null;
  responseLatencyMs?: number | null;
  shouldEndCall?: boolean;
  handoff?: boolean;
  actions?: unknown[];
  metadata?: Record<string, unknown>;
};

const LOG_CONTEXT = 'sofiaVoiceConversationLogger';

function flagEnabled(name: string): boolean {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function flagDisabled(name: string): boolean {
  return String(process.env[name] || '').trim().toLowerCase() === 'false';
}

function measureConversationText(value: string | null | undefined): { length: number; present: boolean } {
  const text = String(value ?? '').trim();
  return { length: text.length, present: Boolean(text) };
}

export function isSofiaVoiceConversationLoggingEnabled(): boolean {
  return !flagDisabled('SOFIA_VOICE_CONVERSATION_LOGGING_ENABLED');
}

export async function logSofiaVoiceConversationTurn(input: ConversationLogInput): Promise<void> {
  if (!isSofiaVoiceConversationLoggingEnabled()) return;
  if (!input.orgId || !input.callId || !input.sessionId) return;

  const transcript = measureConversationText(input.callerTranscript);
  const response = measureConversationText(input.sofiaResponseText);
  const metadata = {
    ...(input.metadata ?? {}),
    callerTranscriptPresent: transcript.present,
    callerTranscriptLength: transcript.length,
    sofiaResponsePresent: response.present,
    sofiaResponseLength: response.length,
    logger: 'sofia_voice_conversation_logger'
  };

  try {
    await upsertSofiaVoiceConversationTurn({
      ...input,
      metadata
    });

    if (flagEnabled('SOFIA_VOICE_CONVERSATION_CLOUD_LOG_ENABLED')) {
      logInfo(LOG_CONTEXT, 'voice.conversation.turn_logged', {
        orgId: input.orgId,
        callId: input.callId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        turnNumber: input.turnNumber,
        turnKind: input.turnKind,
        callerTranscriptPresent: transcript.present,
        callerTranscriptLength: transcript.length,
        sofiaResponsePresent: response.present,
        sofiaResponseLength: response.length,
        responseLatencyMs: input.responseLatencyMs ?? null,
        shouldEndCall: input.shouldEndCall === true,
        handoff: input.handoff === true
      });
    }
  } catch (error) {
    logError(LOG_CONTEXT, 'voice.conversation.turn_log_failed', error, {
      orgId: input.orgId,
      callId: input.callId,
      turnNumber: input.turnNumber,
      turnKind: input.turnKind
    });
  }
}
