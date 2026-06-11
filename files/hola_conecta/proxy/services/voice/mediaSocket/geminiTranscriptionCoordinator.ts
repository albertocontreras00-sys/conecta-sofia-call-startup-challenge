import { logInfo, logWarn } from '../../../utils/logger.js';
import { logSofiaVoiceConversationTurn } from '../../../sofia/voice/sofiaVoiceConversationLogger.ts';
import type { GeminiDomain } from '../infobipMediaWebSocketGeminiTypes.ts';
import { currentVoiceTurnId } from '../infobipMediaWebSocketSession.ts';
import {
  buildVoiceLanguagePromptContext,
  buildVoiceLanguageRealtimeUpdate,
  classifyVoiceLanguageDecision,
  isClearCallerLanguageTurn,
  SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
  voiceLiveLanguageCodeFromConfig,
  type SofiaVoiceResponseLanguage
} from '../sofiaVoiceLanguage.ts';
import {
  emitSofiaVoiceObservabilityPayload,
  flushQueuedSofiaVoiceAssistantTranscriptForVoker,
  queueSofiaVoiceAssistantTranscriptForVoker
} from '../sofiaVoiceObservabilityPayloadService.ts';
import {
  logGeminiTranscription as logGeminiTranscriptionEvent
} from '../sofiaVoiceTranscriptionLogger.ts';
import { observeReceptionistCallerInput } from '../sofiaReceptionistOutcome.ts';
import { phoneLogSummary } from '../voiceLogSanitizer.ts';
import type { SofiaVoiceLanguageState, VoiceSession } from '../voiceSessionTypes.ts';

const SPANISH_INTERRUPTION_OVERRIDE_INSTRUCTION = 'The caller just interrupted in Spanish. Reply in Spanish unless the caller switches again.';
const CALLER_GOODBYE_FINAL_RESPONSE_INSTRUCTION = [
  'The caller just ended the conversation.',
  'Give one short natural closing in Sofia voice, then stop speaking.'
].join(' ');

type PendingInterruptionLanguageCheck = {
  activeDomain: GeminiDomain;
  interruptedAt: number;
  responseLanguageAtInterruption: SofiaVoiceResponseLanguage;
  turnId: string | null;
};

type NextResponseLanguageOverride = {
  activeDomain: GeminiDomain;
  detectedLanguage: SofiaVoiceResponseLanguage;
  instructionSent: boolean;
  language: SofiaVoiceResponseLanguage;
  previousLanguageState: SofiaVoiceLanguageState;
  reason: string;
  responseStarted: boolean;
  setAt: string;
  transcriptPreview: string;
};

export type GeminiTranscriptionCoordinator = {
  clearNextResponseLanguageOverride: (reason: string) => void;
  currentLanguagePromptContext: () => string;
  currentTurnId: (turnNumber?: number) => string | null;
  getResponseLanguage: () => SofiaVoiceResponseLanguage;
  handleInterrupted: () => void;
  handleTurnComplete: () => void;
  logGeminiTranscription: (
    kind: 'caller_input' | 'sofia_output',
    transcription: { text: string; finished: boolean | null },
    generation: number,
    domain: GeminiDomain
  ) => Promise<void>;
  logLanguageStateUpdated: (source: string) => void;
  setResponseLanguage: (language: SofiaVoiceResponseLanguage) => void;
  updateSessionLanguage: (input: {
    detectedLanguage: SofiaVoiceResponseLanguage | null;
    requestedLanguage: SofiaVoiceResponseLanguage | null;
    switchReason: string;
    source: 'caller_text' | 'model_output' | 'identity_override' | 'org_default' | 'system_instruction';
    confidence: number | null;
    transcriptPreview: string;
  }) => void;
};

export function createGeminiTranscriptionCoordinator(input: {
  emitLocalDebugEvent: (event: string, metadata?: Record<string, unknown>) => void;
  getActiveGeminiDomain: () => GeminiDomain;
  getSession: () => VoiceSession | null;
  initialResponseLanguage: SofiaVoiceResponseLanguage;
  logContext: string;
  modelName: string;
  productionTraceMetadata: () => Record<string, unknown>;
  requestEndCall: (reason: string, toolCallId: string | null) => void;
  sendRealtimeTextPayload: (text: string) => boolean;
  transcriptCloudLogEnabled: boolean;
}): GeminiTranscriptionCoordinator {
  let responseLanguage = input.initialResponseLanguage;
  let transcriptionTurnNumber = 0;
  let activeTranscriptionTurnNumber = 0;
  let pendingInterruptionLanguageCheck: PendingInterruptionLanguageCheck | null = null;
  let nextResponseLanguageOverride: NextResponseLanguageOverride | null = null;

  const transcriptPreview = (text: string): string => text.trim().slice(0, 160);

  function isClearCallerGoodbye(text: string): boolean {
    const normalized = text
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^\p{Letter}\p{Number}\s']/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return false;
    return /^(bye|bye bye|goodbye|good bye|thank you|thanks|no thanks|no thank you|that'?s all|that is all|that'?s it|that is it|all set|nothing else|gracias|no gracias|adios|hasta luego|nos vemos)\b/.test(normalized)
      || /\b(bye|goodbye|good bye|thanks bye|thank you bye|gracias adios|adios gracias)\b$/.test(normalized);
  }

  function maybeRequestEndCallFromCallerGoodbye(text: string, turnId: string | null, domain: GeminiDomain): void {
    const activeSession = input.getSession();
    if (!activeSession || !isClearCallerGoodbye(text)) return;
    const instructionSent = input.sendRealtimeTextPayload(CALLER_GOODBYE_FINAL_RESPONSE_INSTRUCTION);
    input.requestEndCall('caller_goodbye', null);
    logInfo(input.logContext, 'voice.goodbye.end_call_requested', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId,
      domain,
      instructionSent,
      transcriptPreview: transcriptPreview(text)
    });
  }

  function currentTurnId(turnNumber = activeTranscriptionTurnNumber || input.getSession()?.turnNumber || 0): string | null {
    return currentVoiceTurnId(input.getSession(), turnNumber);
  }

  function setNextResponseLanguageOverride(args: {
    detectedLanguage: SofiaVoiceResponseLanguage;
    pendingCheck: PendingInterruptionLanguageCheck;
    transcriptPreview: string;
  }): void {
    const activeSession = input.getSession();
    if (!activeSession || args.detectedLanguage !== 'es') return;
    const previousLanguageState = { ...activeSession.languageState };
    const reason = 'spanish_interruption_next_response_override';
    activeSession.languageState = {
      ...activeSession.languageState,
      currentLanguage: 'es',
      responseLanguage: 'es',
      previousLanguage: previousLanguageState.responseLanguage,
      detectedLanguage: 'es',
      requestedLanguage: null,
      languageLockedByCaller: false,
      languageLockReason: 'temporary_spanish_interruption_override',
      languageSwitchReason: reason,
      source: 'caller_text',
      updatedAt: new Date().toISOString()
    };
    responseLanguage = 'es';
    const instructionSent = input.sendRealtimeTextPayload(SPANISH_INTERRUPTION_OVERRIDE_INSTRUCTION);
    nextResponseLanguageOverride = {
      activeDomain: args.pendingCheck.activeDomain,
      detectedLanguage: args.detectedLanguage,
      instructionSent,
      language: 'es',
      previousLanguageState,
      reason,
      responseStarted: false,
      setAt: new Date().toISOString(),
      transcriptPreview: args.transcriptPreview
    };
    logInfo(input.logContext, 'voice.language.next_response_override.set', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: currentTurnId(),
      activeDomain: args.pendingCheck.activeDomain,
      interruptedAt: new Date(args.pendingCheck.interruptedAt).toISOString(),
      responseLanguageAtInterruption: args.pendingCheck.responseLanguageAtInterruption,
      previousResponseLanguage: previousLanguageState.responseLanguage,
      nextResponseLanguageOverride: 'es',
      detectedLanguage: args.detectedLanguage,
      transcriptPreview: args.transcriptPreview,
      instructionSent,
      instruction: SPANISH_INTERRUPTION_OVERRIDE_INSTRUCTION,
      permanentLanguageLockChanged: false
    });
  }

  function clearNextResponseLanguageOverride(reason: string): void {
    const activeSession = input.getSession();
    const override = nextResponseLanguageOverride;
    if (!activeSession || !override) return;
    const shouldRestorePreviousState =
      activeSession.languageState.responseLanguage === override.language
      && activeSession.languageState.languageSwitchReason === override.reason;
    if (shouldRestorePreviousState) {
      activeSession.languageState = {
        ...override.previousLanguageState,
        updatedAt: new Date().toISOString()
      };
      responseLanguage = override.previousLanguageState.responseLanguage;
    } else {
      responseLanguage = activeSession.languageState.responseLanguage;
    }
    nextResponseLanguageOverride = null;
    logInfo(input.logContext, 'voice.language.next_response_override.cleared', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: currentTurnId(),
      activeDomain: input.getActiveGeminiDomain(),
      reason,
      overrideLanguage: override.language,
      detectedLanguage: override.detectedLanguage,
      instructionSent: override.instructionSent,
      restoredPreviousLanguageState: shouldRestorePreviousState,
      responseStarted: override.responseStarted,
      responseLanguageAfterClear: responseLanguage,
      transcriptPreview: override.transcriptPreview
    });
  }

  function markNextResponseLanguageOverrideStarted(args: {
    domain: GeminiDomain;
    generation: number;
    transcriptPreview: string;
    turnId: string | null;
  }): void {
    const override = nextResponseLanguageOverride;
    const activeSession = input.getSession();
    if (!override || !activeSession || override.responseStarted) return;
    override.responseStarted = true;
    logInfo(input.logContext, 'voice.language.next_response_override.response_started', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: args.turnId,
      domain: args.domain,
      generation: args.generation,
      overrideLanguage: override.language,
      detectedLanguage: override.detectedLanguage,
      responseLanguage,
      transcriptPreview: args.transcriptPreview
    });
    clearNextResponseLanguageOverride('sofia_output_started');
  }

  function maybeSetSpanishInterruptionOverride(args: {
    confidence: number | null;
    detectedLanguage: SofiaVoiceResponseLanguage | null;
    requestedLanguage: SofiaVoiceResponseLanguage | null;
    switchReason: string;
    transcriptFinished: boolean;
    transcriptPreview: string;
  }): void {
    const pendingCheck = pendingInterruptionLanguageCheck;
    if (!pendingCheck) return;
    const strongSpanishSignal = args.requestedLanguage === 'es'
      || (args.detectedLanguage === 'es' && typeof args.confidence === 'number' && args.confidence >= 0.75);
    if (!strongSpanishSignal) {
      logInfo(input.logContext, 'voice.language.interruption_override.not_set', {
        ...input.productionTraceMetadata(),
        sessionId: input.getSession()?.sessionId || null,
        callId: input.getSession()?.callId || null,
        turnId: currentTurnId(),
        activeDomain: pendingCheck.activeDomain,
        interruptedAt: new Date(pendingCheck.interruptedAt).toISOString(),
        responseLanguageAtInterruption: pendingCheck.responseLanguageAtInterruption,
        detectedLanguage: args.detectedLanguage,
        requestedLanguage: args.requestedLanguage,
        confidence: args.confidence,
        switchReason: args.switchReason,
        transcriptFinished: args.transcriptFinished,
        transcriptPreview: args.transcriptPreview,
        pendingLanguageCheckKept: !args.transcriptFinished,
        reason: args.transcriptFinished
          ? 'no_strong_spanish_interruption_signal'
          : 'partial_transcript_waiting_for_stronger_spanish_signal'
      });
      if (args.transcriptFinished) {
        pendingInterruptionLanguageCheck = null;
      }
      return;
    }
    pendingInterruptionLanguageCheck = null;
    setNextResponseLanguageOverride({
      detectedLanguage: 'es',
      pendingCheck,
      transcriptPreview: args.transcriptPreview
    });
  }

  async function maybeHandlePendingInterruptionLanguageTranscript(
    transcription: { text: string; finished: boolean | null }
  ): Promise<void> {
    if (!pendingInterruptionLanguageCheck || !transcription.text.trim()) return;
    const activeSession = input.getSession();
    const currentLanguage = activeSession?.languageState.responseLanguage || responseLanguage;
    const languageDecision = await classifyVoiceLanguageDecision({
      orgId: activeSession?.orgId || null,
      text: transcription.text,
      source: 'caller_text',
      currentLanguage
    });
    maybeSetSpanishInterruptionOverride({
      detectedLanguage: languageDecision.detectedLanguage,
      requestedLanguage: languageDecision.requestedLanguage,
      confidence: languageDecision.confidence,
      switchReason: languageDecision.switchReason,
      transcriptFinished: transcription.finished !== false,
      transcriptPreview: languageDecision.transcriptPreview || transcriptPreview(transcription.text)
    });
  }

  function currentLanguagePromptContext(): string {
    const activeSession = input.getSession();
    const overrideInstruction = nextResponseLanguageOverride
      ? SPANISH_INTERRUPTION_OVERRIDE_INSTRUCTION
      : '';
    if (!activeSession) {
      return [
        buildVoiceLanguagePromptContext({
          initialLanguageCode: voiceLiveLanguageCodeFromConfig(),
          currentLanguage: responseLanguage,
          responseLanguage,
          previousLanguage: null,
          detectedLanguage: responseLanguage,
          requestedLanguage: null,
          languageLockedByCaller: false,
          languageLockReason: null,
          languageSwitchReason: 'session_not_created_yet',
          source: 'system_instruction',
          updatedAt: new Date().toISOString()
        }),
        overrideInstruction
      ].filter(Boolean).join(' ');
    }
    return [
      buildVoiceLanguagePromptContext(activeSession.languageState),
      overrideInstruction
    ].filter(Boolean).join(' ');
  }

  function logLanguageStateUpdated(source: string): void {
    const activeSession = input.getSession();
    if (!activeSession) return;
    logInfo(input.logContext, 'voice.language.state_updated', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: currentTurnId(),
      ...phoneLogSummary(activeSession.fromPhone, 'from'),
      previousLanguage: activeSession.languageState.previousLanguage,
      detectedLanguage: activeSession.languageState.detectedLanguage,
      currentLanguage: activeSession.languageState.currentLanguage,
      responseLanguage: activeSession.languageState.responseLanguage,
      requestedLanguage: activeSession.languageState.requestedLanguage,
      languageLockedByCaller: activeSession.languageState.languageLockedByCaller,
      languageLockReason: activeSession.languageState.languageLockReason,
      switchReason: activeSession.languageState.languageSwitchReason,
      source,
      voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
      confidence: null,
      transcriptPreview: ''
    });
  }

  function updateSessionLanguage(args: {
    detectedLanguage: SofiaVoiceResponseLanguage | null;
    requestedLanguage: SofiaVoiceResponseLanguage | null;
    switchReason: string;
    source: 'caller_text' | 'model_output' | 'identity_override' | 'org_default' | 'system_instruction';
    confidence: number | null;
    transcriptPreview: string;
  }): void {
    const activeSession = input.getSession();
    if (!activeSession) return;
    const previousLanguage = activeSession.languageState.responseLanguage;
    let nextLanguage = previousLanguage;
    let languageLockedByCaller = activeSession.languageState.languageLockedByCaller;
    let languageLockReason = activeSession.languageState.languageLockReason;
    let languageSwitchReason = args.switchReason;
    let sourceOfLanguageDecision = args.source;
    const clearCallerTurn = isClearCallerLanguageTurn({
      confidence: args.confidence,
      requestedLanguage: args.requestedLanguage,
      transcriptPreview: args.transcriptPreview
    });

    if (args.detectedLanguage && args.source === 'caller_text') {
      if (!languageLockedByCaller || args.detectedLanguage !== previousLanguage) {
        if (args.requestedLanguage === args.detectedLanguage || clearCallerTurn) {
          nextLanguage = args.detectedLanguage;
          languageLockedByCaller = true;
          languageLockReason = args.detectedLanguage === 'es'
            ? 'caller_spoke_spanish'
            : 'caller_spoke_english';
          sourceOfLanguageDecision = 'caller_text';
        } else {
          languageSwitchReason = 'ambiguous_caller_language_kept_locked_response_language';
        }
      } else {
        languageLockedByCaller = true;
        languageLockReason = languageLockReason || (args.detectedLanguage === 'es'
          ? 'caller_spoke_spanish'
          : 'caller_spoke_english');
      }
    }
    if (args.detectedLanguage && args.source === 'identity_override' && !languageLockedByCaller) {
      nextLanguage = args.detectedLanguage;
      languageSwitchReason = args.switchReason;
      sourceOfLanguageDecision = 'identity_override';
    }

    logInfo(input.logContext, 'voice.language.turn_decision', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: currentTurnId(),
      ...phoneLogSummary(activeSession.fromPhone, 'from'),
      userTranscriptPreview: args.transcriptPreview,
      detectedCallerLanguage: args.detectedLanguage,
      previousResponseLanguage: previousLanguage,
      nextResponseLanguage: nextLanguage,
      languageLockedByCaller,
      languageLockReason,
      languageSwitchReason,
      sourceOfLanguageDecision,
      liveLanguageCodeFromEnv: activeSession.languageState.initialLanguageCode,
      initialResponseLanguageCode: activeSession.languageState.initialLanguageCode,
      languageCodeSentToGemini: false,
      currentLanguage: previousLanguage,
      responseLanguage: nextLanguage,
      requestedLanguage: args.requestedLanguage,
      switchReason: languageSwitchReason,
      source: args.source,
      voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
      confidence: args.confidence,
      transcriptPreview: args.transcriptPreview
    });
    logInfo(input.logContext, 'voice.language.detected', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: currentTurnId(),
      ...phoneLogSummary(activeSession.fromPhone, 'from'),
      previousLanguage,
      detectedLanguage: args.detectedLanguage,
      currentLanguage: previousLanguage,
      requestedLanguage: args.requestedLanguage,
      switchReason: args.switchReason,
      source: args.source,
      responseLanguage: previousLanguage,
      voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
      confidence: args.confidence,
      transcriptPreview: args.transcriptPreview
    });

    if (args.source === 'model_output' && args.detectedLanguage && args.detectedLanguage !== previousLanguage) {
      logWarn(input.logContext, 'voice.language.unexpected_reset_prevented', {
        ...input.productionTraceMetadata(),
        sessionId: activeSession.sessionId,
        callId: activeSession.callId,
        turnId: currentTurnId(),
        ...phoneLogSummary(activeSession.fromPhone, 'from'),
        previousLanguage,
        detectedLanguage: args.detectedLanguage,
        currentLanguage: previousLanguage,
        requestedLanguage: args.requestedLanguage,
        switchReason: 'model_output_language_did_not_update_session_state',
        source: args.source,
        responseLanguage: previousLanguage,
        voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
        confidence: args.confidence,
        transcriptPreview: args.transcriptPreview
      });
      return;
    }

    if (args.detectedLanguage && args.detectedLanguage !== previousLanguage && nextLanguage === previousLanguage && args.source === 'caller_text') {
      logWarn(input.logContext, 'voice.language.unexpected_reset_prevented', {
        ...input.productionTraceMetadata(),
        sessionId: activeSession.sessionId,
        callId: activeSession.callId,
        turnId: currentTurnId(),
        ...phoneLogSummary(activeSession.fromPhone, 'from'),
        previousLanguage,
        detectedLanguage: args.detectedLanguage,
        currentLanguage: previousLanguage,
        requestedLanguage: args.requestedLanguage,
        switchReason: languageSwitchReason,
        source: args.source,
        responseLanguage: previousLanguage,
        voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
        confidence: args.confidence,
        transcriptPreview: args.transcriptPreview
      });
      return;
    }

    if (
      nextLanguage === previousLanguage
      && languageLockedByCaller === activeSession.languageState.languageLockedByCaller
      && languageLockReason === activeSession.languageState.languageLockReason
    ) {
      return;
    }

    logInfo(input.logContext, 'voice.language.switch_requested', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: currentTurnId(),
      ...phoneLogSummary(activeSession.fromPhone, 'from'),
      previousLanguage,
      detectedLanguage: args.detectedLanguage,
      currentLanguage: previousLanguage,
      requestedLanguage: args.requestedLanguage,
      switchReason: languageSwitchReason,
      source: sourceOfLanguageDecision,
      responseLanguage: nextLanguage,
      voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
      confidence: args.confidence,
      transcriptPreview: args.transcriptPreview
    });

    activeSession.languageState = {
      initialLanguageCode: activeSession.languageState.initialLanguageCode,
      currentLanguage: nextLanguage,
      responseLanguage: nextLanguage,
      previousLanguage,
      detectedLanguage: args.detectedLanguage,
      requestedLanguage: args.requestedLanguage,
      languageLockedByCaller,
      languageLockReason,
      languageSwitchReason,
      source: sourceOfLanguageDecision,
      updatedAt: new Date().toISOString()
    };
    responseLanguage = nextLanguage;
    const realtimeContextUpdateSent = input.sendRealtimeTextPayload(
      buildVoiceLanguageRealtimeUpdate(activeSession.languageState)
    );
    logInfo(input.logContext, 'voice.language.state_updated', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: currentTurnId(),
      ...phoneLogSummary(activeSession.fromPhone, 'from'),
      previousLanguage,
      detectedLanguage: args.detectedLanguage,
      currentLanguage: nextLanguage,
      responseLanguage: nextLanguage,
      requestedLanguage: args.requestedLanguage,
      languageLockedByCaller,
      languageLockReason,
      switchReason: languageSwitchReason,
      source: sourceOfLanguageDecision,
      realtimeContextUpdateSent,
      voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
      confidence: args.confidence,
      transcriptPreview: args.transcriptPreview
    });
  }

  async function logGeminiTranscription(
    kind: 'caller_input' | 'sofia_output',
    transcription: { text: string; finished: boolean | null },
    generation: number,
    domain: GeminiDomain
  ): Promise<void> {
    const shouldPersistTurn = transcription.finished !== false && Boolean(transcription.text.trim());
    if (shouldPersistTurn && kind === 'caller_input') {
      transcriptionTurnNumber += 1;
      activeTranscriptionTurnNumber = transcriptionTurnNumber;
    } else if (shouldPersistTurn && activeTranscriptionTurnNumber === 0) {
      transcriptionTurnNumber += 1;
      activeTranscriptionTurnNumber = transcriptionTurnNumber;
    }
    const session = input.getSession();
    const turnNumber = activeTranscriptionTurnNumber || session?.turnNumber || 0;
    const turnId = currentTurnId(turnNumber);
    logGeminiTranscriptionEvent({
      domain,
      emitLocalDebugEvent: input.emitLocalDebugEvent,
      generation,
      kind,
      logContext: input.logContext,
      responseLanguage,
      session,
      transcription,
      transcriptCloudLogEnabled: input.transcriptCloudLogEnabled,
      turnId,
      turnNumber
    });
    if (shouldPersistTurn && session) {
      const transcriptEvent = {
        orgId: session.orgId,
        callId: session.callId,
        sessionId: session.sessionId,
        turnId,
        direction: kind === 'caller_input' ? 'caller' : 'sofia',
        transcriptText: transcription.text,
        timestamp: new Date().toISOString(),
        source: 'gemini_live',
        language: responseLanguage,
        modelName: input.modelName,
        toolMetadata: {
          generation,
          domain,
          finished: transcription.finished
        }
      } as const;
      if (kind === 'sofia_output') {
        queueSofiaVoiceAssistantTranscriptForVoker(transcriptEvent);
        if (transcription.finished === true) {
          flushQueuedSofiaVoiceAssistantTranscriptForVoker({
            callId: session.callId,
            reason: 'transcript_finished'
          });
        }
      } else {
        flushQueuedSofiaVoiceAssistantTranscriptForVoker({
          callId: session.callId,
          reason: 'before_caller_input'
        });
        emitSofiaVoiceObservabilityPayload(transcriptEvent);
      }
    }
    if (kind === 'caller_input' && pendingInterruptionLanguageCheck) {
      await maybeHandlePendingInterruptionLanguageTranscript(transcription);
    }
    if (shouldPersistTurn && session) {
      await logSofiaVoiceConversationTurn({
        orgId: session.orgId,
        callId: session.callId,
        sessionId: session.sessionId,
        turnId,
        turnNumber,
        turnKind: 'voice_turn',
        callerTranscript: kind === 'caller_input' ? transcription.text : null,
        sofiaResponseText: kind === 'sofia_output' ? transcription.text : null,
        metadata: {
          source: 'gemini_live_transcription',
          sender: 'gemini_live',
          converter: 'infobipMediaWebSocketService.logGeminiTranscription',
          receiver: 'sofia_voice_conversation_turns',
          generation,
          domain,
          kind,
          finished: transcription.finished,
          responseLanguage
        }
      });
    }
    if (kind === 'sofia_output' && shouldPersistTurn) {
      logInfo(input.logContext, 'voice.language.sofia_response_language_used', {
        ...input.productionTraceMetadata(),
        sessionId: session?.sessionId || null,
        callId: session?.callId || null,
        turnId,
        domain,
        generation,
        responseLanguage,
        nextResponseLanguageOverrideActive: Boolean(nextResponseLanguageOverride),
        nextResponseLanguageOverride: nextResponseLanguageOverride?.language || null,
        transcriptPreview: transcriptPreview(transcription.text)
      });
      markNextResponseLanguageOverrideStarted({
        domain,
        generation,
        transcriptPreview: transcriptPreview(transcription.text),
        turnId
      });
    }
    if (kind === 'caller_input' && shouldPersistTurn) {
      const activeSession = input.getSession();
      const currentLanguage = activeSession?.languageState.responseLanguage || responseLanguage;
      const languageDecision = await classifyVoiceLanguageDecision({
        orgId: activeSession?.orgId || null,
        text: transcription.text,
        source: 'caller_text',
        currentLanguage
      });
      updateSessionLanguage({
        detectedLanguage: languageDecision.detectedLanguage,
        requestedLanguage: languageDecision.requestedLanguage,
        switchReason: languageDecision.switchReason,
        source: 'caller_text',
        confidence: languageDecision.confidence,
        transcriptPreview: languageDecision.transcriptPreview || transcriptPreview(transcription.text)
      });
      const languageTranscriptPreview = languageDecision.transcriptPreview || transcriptPreview(transcription.text);
      if ((activeSession?.languageState.responseLanguage || responseLanguage) === 'es') {
        if (pendingInterruptionLanguageCheck) {
          logInfo(input.logContext, 'voice.language.interruption_override.not_set', {
            ...input.productionTraceMetadata(),
            sessionId: activeSession?.sessionId || null,
            callId: activeSession?.callId || null,
            turnId: pendingInterruptionLanguageCheck.turnId,
            activeGeminiDomain: input.getActiveGeminiDomain(),
            interruptedAt: new Date(pendingInterruptionLanguageCheck.interruptedAt).toISOString(),
            responseLanguageAtInterruption: pendingInterruptionLanguageCheck.responseLanguageAtInterruption,
            detectedLanguage: languageDecision.detectedLanguage,
            requestedLanguage: languageDecision.requestedLanguage,
            confidence: languageDecision.confidence,
            switchReason: languageDecision.switchReason,
            transcriptPreview: languageTranscriptPreview,
            reason: 'normal_language_state_already_spanish'
          });
          pendingInterruptionLanguageCheck = null;
        }
      } else {
        maybeSetSpanishInterruptionOverride({
          detectedLanguage: languageDecision.detectedLanguage,
          requestedLanguage: languageDecision.requestedLanguage,
          confidence: languageDecision.confidence,
          switchReason: languageDecision.switchReason,
          transcriptFinished: true,
          transcriptPreview: languageTranscriptPreview
        });
      }
      observeReceptionistCallerInput({
        session: activeSession,
        transcript: transcription.text,
        language: responseLanguage
      });
      maybeRequestEndCallFromCallerGoodbye(transcription.text, turnId, domain);
    }
  }

  return {
    clearNextResponseLanguageOverride,
    currentLanguagePromptContext,
    currentTurnId,
    getResponseLanguage: () => responseLanguage,
    handleInterrupted: () => {
      const activeSession = input.getSession();
      if (activeSession) {
        flushQueuedSofiaVoiceAssistantTranscriptForVoker({
          callId: activeSession.callId,
          reason: 'interrupted'
        });
      }
      pendingInterruptionLanguageCheck = {
        activeDomain: input.getActiveGeminiDomain(),
        interruptedAt: Date.now(),
        responseLanguageAtInterruption: responseLanguage,
        turnId: currentTurnId()
      };
      logInfo(input.logContext, 'voice.gemini.interrupted', {
        ...input.productionTraceMetadata(),
        sessionId: input.getSession()?.sessionId || null,
        callId: input.getSession()?.callId || null,
        turnId: currentTurnId(),
        responseLanguage,
        activeDomain: input.getActiveGeminiDomain(),
        action: 'infobip_clear_buffer',
        pendingLanguageCheckSet: true
      });
    },
    handleTurnComplete: () => {
      const activeSession = input.getSession();
      if (activeSession) {
        flushQueuedSofiaVoiceAssistantTranscriptForVoker({
          callId: activeSession.callId,
          reason: 'turn_complete'
        });
      }
      if (nextResponseLanguageOverride?.responseStarted) {
        clearNextResponseLanguageOverride('turn_complete');
      }
    },
    logGeminiTranscription,
    logLanguageStateUpdated,
    setResponseLanguage: (language) => { responseLanguage = language; },
    updateSessionLanguage
  };
}
