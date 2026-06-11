import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { logError, logInfo } from '../../utils/logger.js';
import type { InfobipWebSocketContext, VoiceSession } from './voiceSessionTypes.ts';
import { voiceSessionManager } from './voiceSessionManager.ts';
import {
  sendInfobipClearBuffer,
} from './sofiaVoiceInfobipFrameHelpers.ts';
import type {
  VoiceBookingLookupSummary,
  SofiaVoiceBookingOption as LiveBookingOption
} from '../../sofia/services/sofiaVoiceBookingService.ts';
import type {
  SofiaPendingContactFieldUpdate,
  SofiaPendingContactNoteOrTask
} from './tools/identity/types.ts';
import type { SofiaIdentityResolutionResult } from '../../sofia/sofia_identity_agent/identityTypes.ts';
import {
  GEMINI_LIVE_MODEL, INITIAL_CALL_HISTORY_SUMMARY, INITIAL_GEMINI_DOMAIN, REBIND_AUDIO_BUFFER_MAX_BYTES,
  REBIND_AUDIO_BUFFER_MS, buildTemporalContext
} from './infobipMediaWebSocketGemini.ts';
import type { GeminiDomain } from './infobipMediaWebSocketGeminiTypes.ts';
import {
  VOICE_END_CALL_FALLBACK_DELAY_MS,
  VOICE_TRANSCRIPT_CLOUD_LOG_ENABLED
} from './sofiaVoiceRuntimeConfig.ts';
import {
  initialVoiceLanguageFromConfig,
} from './sofiaVoiceLanguage.ts';
import {
  DEFAULT_CALLER_IDENTITY_SUMMARY,
} from './sofiaVoiceIdentityContext.ts';
import {
  hangupInfobipCall,
  hangupInfobipDialog
} from './infobipCallsApiService.ts';
import {
  emitSofiaVoiceFinalSummaryVokerEvent,
  flushQueuedSofiaVoiceAssistantTranscriptForVoker,
} from './sofiaVoiceObservabilityPayloadService.ts';
import { scheduleVoiceToolResponseAudioWatchdog } from './sofiaVoiceDebugEvents.ts';
import { SofiaGeminiLiveBridge } from './sofiaGeminiLiveBridge.ts';
import {
  finalizeSofiaReceptionistCall,
} from './sofiaReceptionistOutcome.ts';
import { publishSofiaLiveCallState } from '../phone/phoneLiveStateService.ts';
import {
  createInfobipMediaWebSocketSessionTimers,
  cleanupInfobipMediaWebSocketSession
} from './infobipMediaWebSocketSession.ts';
import { createInfobipMediaWebSocketOutboundAudio } from './infobipMediaWebSocketOutboundAudio.ts';
import {
  createInfobipMediaWebSocketObservability,
  initialAudioLogCounters
} from './infobipMediaWebSocketObservability.ts';
import { bindMediaSocketConnectionLifecycle } from './mediaSocket/connectionLifecycle.ts';
import {
  createGeminiAudioBufferRuntime,
  type GeminiAudioBufferRuntime
} from './mediaSocket/geminiAudioBuffer.ts';
import {
  createGeminiToolCallCoordinator,
  type GeminiToolCallCoordinator
} from './mediaSocket/geminiToolCallCoordinator.ts';
import {
  createMediaSocketEndCallCoordinator,
  type MediaSocketEndCallCoordinator
} from './mediaSocket/endCallCoordinator.ts';
import { createInfobipMediaFrameHandler } from './mediaSocket/infobipMediaFrameHandler.ts';
import { bindInfobipMessageRouter } from './mediaSocket/infobipMessageRouter.ts';
import { createGeminiToolResponseSender } from './mediaSocket/geminiToolResponseSender.ts';
import { createGeminiTranscriptionCoordinator } from './mediaSocket/geminiTranscriptionCoordinator.ts';
import { createInfobipStartHandler } from './mediaSocket/infobipStartHandler.ts';
import { loadSofiaBusinessKnowledgeVoiceContext } from '../settings/sofiaSettingsService.ts';
import {
  applyStartupOwnerTestOverride,
  resolveStartupCallerIdentity,
  resolveStartupGreetingBusinessName,
  resolveStartupTemporalContext
} from './mediaSocket/sessionStartupContext.ts';
import { createSofiaVoiceToolContextFactories } from './mediaSocket/toolContextFactories.ts';

const LOG_CONTEXT = 'infobipMediaWebSocketService';

export function handleInfobipMediaWebSocket(context: InfobipWebSocketContext): void {
  const { ws } = context;
  const correlationId = context.requestId || crypto.randomUUID();
  let session: VoiceSession | null = null;
  let closed = false;
  let infobipContentType: string | null = null;
  let currentSessionHistory = INITIAL_CALL_HISTORY_SUMMARY;
  let callerIdentity: SofiaIdentityResolutionResult | null = null;
  let callerIdentitySummary = DEFAULT_CALLER_IDENTITY_SUMMARY;
  let callTemporalContext = buildTemporalContext(null);
  let businessKnowledgeContext = '';
  let greetingBusinessName = 'this business';
  const handoffBuffer: Array<{ pcm16k: Buffer; receivedAt: number }> = [];
  const bookingSlotMap = new Map<string, LiveBookingOption>();
  const activeBookingMap = new Map<string, VoiceBookingLookupSummary>();
  const pendingContactFieldUpdates = new Map<string, SofiaPendingContactFieldUpdate>();
  const pendingContactNotesOrTasks = new Map<string, SofiaPendingContactNoteOrTask>();
  const recentToolEvents: Record<string, unknown>[] = [];
  const recentLocalDebugEvents: Record<string, unknown>[] = [];
  const audioLogCounters = initialAudioLogCounters();
  let handoffBufferBytes = 0;
  const localDebugEnabled = context.query.get('voiceDebug') === '1';

  const observability = createInfobipMediaWebSocketObservability({
    logContext: LOG_CONTEXT,
    localDebugEnabled,
    ws,
    getSession: () => session,
    recentLocalDebugEvents,
    audioLogCounters,
    getOutboundCloseMetrics: () => ({
      handoffBufferFrames: handoffBuffer.length,
      handoffBufferBytes,
      ...outboundAudio.getCloseMetrics()
    })
  });

  const {
    sessionEnvelope,
    productionTraceMetadata,
    shouldLogFrameDetail,
    emitLocalDebugEvent,
    pushLiveDebugEvent,
    logAudioSummary
  } = observability;

  const handoffBufferBytesForCleanup = {
    get value() { return handoffBufferBytes; },
    set value(v: number) { handoffBufferBytes = v; }
  };
  let providerHangupRequested = false;

  async function closeProviderCall(reason: string): Promise<void> {
    const activeSession = session;
    if (!activeSession || providerHangupRequested) return;
    providerHangupRequested = true;
    try {
      if (activeSession.dialogId) {
        await hangupInfobipDialog({ dialogId: activeSession.dialogId });
      } else {
        await hangupInfobipCall({ callId: activeSession.callId, errorCode: 'NORMAL_HANGUP' });
      }
      logInfo(LOG_CONTEXT, 'voice.infobip.provider_hangup.completed', {
        ...productionTraceMetadata(),
        sessionId: activeSession.sessionId,
        callId: activeSession.callId,
        dialogId: activeSession.dialogId || null,
        reason
      });
    } catch (error) {
      logError(LOG_CONTEXT, 'voice.infobip.provider_hangup.failed', error, {
        ...productionTraceMetadata(),
        sessionId: activeSession.sessionId,
        callId: activeSession.callId,
        dialogId: activeSession.dialogId || null,
        reason
      });
      throw error;
    }
  }

  function cleanup(reason: string): void {
    cleanupInfobipMediaWebSocketSession({
      logContext: LOG_CONTEXT,
      observability,
      outboundAudio,
      geminiBridge,
      getSession: () => session,
      isClosed: () => closed,
      setClosed: (value) => { closed = value; },
      clearAllTimers: () => sessionTimers.clearAllTimers(),
      clearHangupTimer: () => endCallCoordinator?.clearHangupTimer(),
      handoffBuffer,
      handoffBufferBytes: handoffBufferBytesForCleanup,
      bookingSlotMap,
      activeBookingMap,
      pendingContactFieldUpdates,
      pendingContactNotesOrTasks,
      getHangupState: () => endCallCoordinator?.getHangupState() ?? { requested: false, reason: null }
    }, reason);
  }

  let endCallCoordinator: MediaSocketEndCallCoordinator | null = null;
  const closeCallAfterFinalAudio = (reason: string): Promise<void> => (
    endCallCoordinator?.closeCallAfterFinalAudio(reason) ?? Promise.resolve()
  );

  const outboundAudio = createInfobipMediaWebSocketOutboundAudio({
    ws,
    logContext: LOG_CONTEXT,
    observability,
    audioLogCounters,
    getSession: () => session,
    getInfobipContentType: () => infobipContentType,
    getClosed: () => closed,
    cleanup,
    getHangupRequested: () => endCallCoordinator?.getHangupState().requested ?? false,
    closeCallAfterFinalAudio
  });

  endCallCoordinator = createMediaSocketEndCallCoordinator({
    emitLocalDebugEvent,
    fallbackDelayMs: VOICE_END_CALL_FALLBACK_DELAY_MS,
    flushOutboundQueue: () => outboundAudio.flushOutboundQueue(),
    getClosed: () => closed,
    getSession: () => session,
    logContext: LOG_CONTEXT,
    productionTraceMetadata,
    closeProviderCall,
    requestOutboundTurnFlush: () => outboundAudio.requestOutboundTurnFlush(),
    ws
  });

  let geminiAudioBufferRuntime: GeminiAudioBufferRuntime | null = null;
  let geminiToolCallCoordinator: GeminiToolCallCoordinator | null = null;
  function bufferGeminiAudio(pcm16k: Buffer, infobipChunkBytes: number, reason: string): void {
    geminiAudioBufferRuntime?.bufferGeminiAudio(pcm16k, infobipChunkBytes, reason);
  }
  function sendGeminiAudio(pcm16k: Buffer, infobipChunkBytes: number, source: 'live' | 'buffered'): void {
    geminiAudioBufferRuntime?.sendGeminiAudio(pcm16k, infobipChunkBytes, source);
  }
  function flushBufferedGeminiAudio(input: { domain: GeminiDomain; generation: number; initialCallStart: boolean }): Promise<void> {
    return geminiAudioBufferRuntime?.flushBufferedGeminiAudio(input) ?? Promise.resolve();
  }
  function handleGeminiFunctionCall(call: Parameters<GeminiToolCallCoordinator>[0]): void {
    geminiToolCallCoordinator?.(call);
  }

  const geminiBridgeRef: { current: SofiaGeminiLiveBridge | null } = { current: null };
  const currentGeminiBridge = (): SofiaGeminiLiveBridge => {
    if (!geminiBridgeRef.current) {
      throw new Error('Gemini Live bridge was not initialized before use');
    }
    return geminiBridgeRef.current;
  };
  const transcriptionCoordinator = createGeminiTranscriptionCoordinator({
    emitLocalDebugEvent,
    getActiveGeminiDomain: () => currentGeminiBridge().getActiveDomain(),
    getSession: () => session,
    initialResponseLanguage: initialVoiceLanguageFromConfig(),
    logContext: LOG_CONTEXT,
    modelName: GEMINI_LIVE_MODEL,
    productionTraceMetadata,
    requestEndCall: (reason, toolCallId) => endCallCoordinator?.requestEndCall(reason, toolCallId),
    sendRealtimeTextPayload: (text) => currentGeminiBridge().sendRealtimeTextPayload(text),
    transcriptCloudLogEnabled: VOICE_TRANSCRIPT_CLOUD_LOG_ENABLED
  });

  const geminiBridge = new SofiaGeminiLiveBridge(LOG_CONTEXT, {
    clearOutboundAudioForInterruption: () => {
      const snapshot = outboundAudio.clearForInterruption({ preserveGeminiPlaybackPcm: true });
      logInfo(LOG_CONTEXT, 'voice.audio.barge_in_clear_requested', {
        ...productionTraceMetadata(),
        sessionId: session?.sessionId || null,
        callId: session?.callId || null,
        turnId: currentTurnId(),
        activeGeminiDomain: currentGeminiBridge().getActiveDomain(),
        currentLanguage: session?.languageState.currentLanguage || null,
        responseLanguage: session?.languageState.responseLanguage || null,
        languageSource: session?.languageState.source || null,
        clearSequence: snapshot.clearSequence,
        clearedAt: snapshot.clearedAt,
        preserveGeminiPlaybackPcm: snapshot.preserveGeminiPlaybackPcm,
        outboundQueueFramesBeforeClear: snapshot.outboundQueueFramesBeforeClear,
        outboundQueueBytesBeforeClear: snapshot.outboundQueueBytesBeforeClear,
        outboundAudioFrameBufferBytesBeforeClear: snapshot.outboundAudioFrameBufferBytesBeforeClear,
        geminiPlaybackPcmBufferBytesBeforeClear: snapshot.geminiPlaybackPcmBufferBytesBeforeClear,
        outboundJitterReleasedBeforeClear: snapshot.outboundJitterReleasedBeforeClear,
        outboundTurnFlushRequestedBeforeClear: snapshot.outboundTurnFlushRequestedBeforeClear,
        nextOutboundFrameDueAtMsBeforeClear: snapshot.nextOutboundFrameDueAtMsBeforeClear,
        outboundFrameSequenceBeforeClear: snapshot.outboundFrameSequenceBeforeClear,
        modelResponseIndexBeforeClear: snapshot.modelResponseIndexBeforeClear,
        responseAudioActiveBeforeClear: snapshot.responseAudioActiveBeforeClear,
        responseAudioChunkIndexBeforeClear: snapshot.responseAudioChunkIndexBeforeClear,
        responseOutboundFrameIndexBeforeClear: snapshot.responseOutboundFrameIndexBeforeClear,
        currentResponseLanguageBeforeClear: snapshot.currentResponseLanguageBeforeClear,
        currentResponseStartedAfterClearBeforeClear: snapshot.currentResponseStartedAfterClearBeforeClear,
        clearSinceLastResponseAudioBeforeClear: snapshot.clearSinceLastResponseAudioBeforeClear,
        ignoredPreStartGeminiAudioChunksBeforeClear: snapshot.ignoredPreStartGeminiAudioChunksBeforeClear,
        lastOutboundAudioQueuedAt: snapshot.lastOutboundAudioQueuedAt,
        lastOutboundFrameSentAtMs: snapshot.lastOutboundFrameSentAtMs,
        outboundQueueFramesAfterClear: snapshot.outboundQueueFramesAfterClear,
        outboundQueueBytesAfterClear: snapshot.outboundQueueBytesAfterClear,
        outboundAudioFrameBufferBytesAfterClear: snapshot.outboundAudioFrameBufferBytesAfterClear,
        geminiPlaybackPcmBufferBytesAfterClear: snapshot.geminiPlaybackPcmBufferBytesAfterClear,
        action: 'infobip_clear_buffer',
        rawAudioLogged: false,
        contentsLogged: false
      });
      sendInfobipClearBuffer(ws, session, LOG_CONTEXT, {
        ...productionTraceMetadata(),
        turnId: currentTurnId(),
        activeGeminiDomain: currentGeminiBridge().getActiveDomain(),
        currentLanguage: session?.languageState.currentLanguage || null,
        responseLanguage: session?.languageState.responseLanguage || null,
        languageSource: session?.languageState.source || null,
        clearSequence: snapshot.clearSequence,
        clearedAt: snapshot.clearedAt,
        preserveGeminiPlaybackPcm: snapshot.preserveGeminiPlaybackPcm
      });
    },
    emitLocalDebugEvent,
    flushBufferedGeminiAudio,
    getCurrentSessionHistory: () => currentSessionHistory,
    getGreetingBusinessName: () => greetingBusinessName,
    getBusinessKnowledgeContext: () => businessKnowledgeContext,
    getHandoffBufferMetrics: () => ({
      frames: handoffBuffer.length,
      bytes: handoffBufferBytes
    }),
    getIdentitySummary: () => callerIdentitySummary,
    getLanguageContext: () => transcriptionCoordinator.currentLanguagePromptContext(),
    getSession: () => session,
    getTemporalContext: () => callTemporalContext,
    isClosed: () => closed,
    onAudioReceived: (audio) => {
      void outboundAudio.queueGeminiAudio(audio).catch((error) => {
        logError(LOG_CONTEXT, 'voice.gemini.audio_forward_failed', error, {
          sessionId: session?.sessionId || null,
          callId: session?.callId || null
        });
      });
    },
    onFatalClose: (code, reason) => {
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    },
    onFunctionCall: handleGeminiFunctionCall,
    onInputTranscription: (transcription, generation, domain) => {
      void transcriptionCoordinator.logGeminiTranscription('caller_input', transcription, generation, domain).catch((error) => {
        logError(LOG_CONTEXT, 'voice.gemini.transcription_handler_failed', error, {
          sessionId: session?.sessionId || null,
          callId: session?.callId || null,
          kind: 'caller_input'
        });
      });
    },
    onInterrupted: () => {
      transcriptionCoordinator.handleInterrupted();
    },
    onOutputTranscription: (transcription, generation, domain) => {
      void transcriptionCoordinator.logGeminiTranscription('sofia_output', transcription, generation, domain).catch((error) => {
        logError(LOG_CONTEXT, 'voice.gemini.transcription_handler_failed', error, {
          sessionId: session?.sessionId || null,
          callId: session?.callId || null,
          kind: 'sofia_output'
        });
      });
    },
    onTurnComplete: () => {
      outboundAudio.requestTurnCompleteFlush();
      const queueDepth = outboundAudio.getOutboundQueueDepth();
      logInfo(LOG_CONTEXT, 'voice.gemini.turn_complete', {
        ...productionTraceMetadata(),
        sessionId: session?.sessionId || null,
        callId: session?.callId || null,
        queuedFrames: queueDepth.frames,
        queuedBytes: queueDepth.bytes
      });
      void outboundAudio.flushOutboundQueue().catch((error) => {
        logError(LOG_CONTEXT, 'voice.gemini.turn_complete_flush_failed', error, {
          sessionId: session?.sessionId || null,
          callId: session?.callId || null
        });
      });
      transcriptionCoordinator.handleTurnComplete();
    }
  });
  geminiBridgeRef.current = geminiBridge;

  const sessionTimers = createInfobipMediaWebSocketSessionTimers({
    ws,
    logContext: LOG_CONTEXT,
    correlationId,
    closeProviderCall,
    getSession: () => session,
    isClosed: () => closed
  });

  function scheduleToolResponseAudioWatchdog(toolName: string, responseSummary: Record<string, unknown>): void {
    scheduleVoiceToolResponseAudioWatchdog({
      activeGeminiDomain: () => geminiBridge.getActiveDomain(),
      currentSessionId: () => session?.sessionId || null,
      emitLocalDebugEvent,
      isClosed: () => closed || !session,
      lastOutboundAudioQueuedAt: () => outboundAudio.getLastOutboundAudioQueuedAt(),
      logContext: LOG_CONTEXT,
      responseSummary,
      session,
      toolName
    });
  }

  const sendGeminiToolResponse = createGeminiToolResponseSender({
    emitLocalDebugEvent,
    getActiveGeminiDomain: () => geminiBridge.getActiveDomain(),
    getGeminiSocket: () => geminiBridge.getSocket(),
    getResponseLanguage: () => transcriptionCoordinator.getResponseLanguage(),
    getSession: () => session,
    logContext: LOG_CONTEXT,
    productionTraceMetadata,
    pushLiveDebugEvent,
    recentToolEvents,
    scheduleToolResponseAudioWatchdog
  });

  function currentTurnId(turnNumber?: number): string | null {
    return transcriptionCoordinator.currentTurnId(turnNumber);
  }

  logInfo(LOG_CONTEXT, 'voice.ws.connected', {
    correlationId,
    path: context.path,
    remoteAddress: context.remoteAddress,
    activeSessions: voiceSessionManager.size()
  });
  logInfo(LOG_CONTEXT, 'voice.ws.upgrade.received', {
    correlationId,
    path: context.path,
    remoteAddress: context.remoteAddress
  });

  function buildCurrentSessionHistory(nextDomain: GeminiDomain, handoffSummary: string): string {
    if (!session) return currentSessionHistory;
    return [
      `Handoff summary from previous Gemini domain: ${handoffSummary}`,
      `The Infobip call remains connected while Sofia silently rebinds Gemini from ${geminiBridge.getActiveDomain()} to ${nextDomain}.`,
      `Call id: ${session.callId}. Session id: ${session.sessionId}. Organization id: ${session.orgId}.`,
      callerIdentitySummary,
      transcriptionCoordinator.currentLanguagePromptContext(),
      `There is no full STT transcript in this Live API bridge. Continue from the caller audio and this routing context.`
    ].join(' ');
  }

  async function resolveInitialCallerIdentity(): Promise<void> {
    const activeSession = session;
    if (!activeSession) return;
    const identityContext = await resolveStartupCallerIdentity({
      currentTurnId,
      logContext: LOG_CONTEXT,
      productionTraceMetadata,
      session: activeSession,
      updateSessionLanguage: transcriptionCoordinator.updateSessionLanguage
    });
    callerIdentity = identityContext.callerIdentity;
    callerIdentitySummary = identityContext.callerIdentitySummary;
  }

  function applyOwnerTestOverride(): void {
    const activeSession = session;
    if (!activeSession) return;
    applyStartupOwnerTestOverride({
      currentTurnId,
      logContext: LOG_CONTEXT,
      productionTraceMetadata,
      session: activeSession
    });
  }

  geminiAudioBufferRuntime = createGeminiAudioBufferRuntime({
    audioLogCounters,
    bufferMaxBytes: REBIND_AUDIO_BUFFER_MAX_BYTES,
    bufferWindowMs: REBIND_AUDIO_BUFFER_MS,
    getActiveGeminiDomain: () => geminiBridge.getActiveDomain(),
    getHandoffBufferBytes: () => handoffBufferBytes,
    getInfobipContentType: () => infobipContentType,
    getSession: () => session,
    handoffBuffer,
    isGeminiReadyForAudio: () => geminiBridge.isReadyForAudio(),
    logContext: LOG_CONTEXT,
    productionTraceMetadata,
    sendRealtimeAudioPayload: (payload) => geminiBridge.sendRealtimeAudioPayload(payload),
    setHandoffBufferBytes: (value) => { handoffBufferBytes = value; },
    shouldLogFrameDetail,
    startupFlushFrameIntervalMs: 20
  });

  const toolContextFactories = createSofiaVoiceToolContextFactories({
    activeBookingMap,
    bookingSlotMap,
    emitLocalDebugEvent,
    getActiveGeminiDomain: () => geminiBridge.getActiveDomain(),
    getCallerIdentity: () => callerIdentity,
    getSession: () => session,
    logContext: LOG_CONTEXT,
    pendingContactFieldUpdates,
    pendingContactNotesOrTasks,
    recentLocalDebugEvents,
    recentToolEvents,
    sendGeminiToolResponse
  });

  geminiToolCallCoordinator = createGeminiToolCallCoordinator({
    buildCurrentSessionHistory,
    connectToGeminiDomain: (domain, sessionHistory) => geminiBridge.connectToDomain(domain, sessionHistory),
    emitLocalDebugEvent,
    getActiveGeminiDomain: () => geminiBridge.getActiveDomain(),
    getGeminiSocket: () => geminiBridge.getSocket(),
    getSession: () => session,
    logContext: LOG_CONTEXT,
    productionTraceMetadata,
    pushLiveDebugEvent,
    recentToolEvents,
    requestEndCall: (reason, toolCallId) => endCallCoordinator?.requestEndCall(reason, toolCallId),
    sendGeminiToolResponse,
    setCurrentSessionHistory: (sessionHistory) => { currentSessionHistory = sessionHistory; },
    setRebindInProgress: (value) => { geminiBridge.setRebindInProgress(value); },
    toolContextFactories
  });

  const startRealtimeLoop = createInfobipStartHandler({
    applyOwnerTestOverride,
    clearHandshakeTimer: () => sessionTimers.clearHandshakeTimer(),
    connectToInitialGeminiDomain: (domain, sessionHistory) => {
      geminiBridge.connectToDomain(domain, sessionHistory, { initialCallStart: true });
    },
    correlationId,
    getCurrentSessionHistory: () => currentSessionHistory,
    initialGeminiDomain: INITIAL_GEMINI_DOMAIN,
    logContext: LOG_CONTEXT,
    logLanguageStateUpdated: transcriptionCoordinator.logLanguageStateUpdated,
    productionTraceMetadata,
    resolveInitialCallerIdentity,
    resolveStartupBusinessKnowledgeContext: async (activeSession) => {
      try {
        return await loadSofiaBusinessKnowledgeVoiceContext(activeSession.orgId);
      } catch (error) {
        logError(LOG_CONTEXT, 'voice.sofia_knowledge_context_load_failed', error, {
          orgId: activeSession.orgId,
          callId: activeSession.callId,
          sessionId: activeSession.sessionId
        });
        return '';
      }
    },
    resolveStartupGreetingBusinessName: (activeSession) => resolveStartupGreetingBusinessName({
      logContext: LOG_CONTEXT,
      orgId: activeSession.orgId,
      session: activeSession
    }),
    resolveStartupTemporalContext: (activeSession) => resolveStartupTemporalContext({
      logContext: LOG_CONTEXT,
      session: activeSession
    }),
    sessionEnvelope,
    setCallTemporalContext: (value) => { callTemporalContext = value; },
    setBusinessKnowledgeContext: (value) => { businessKnowledgeContext = value; },
    setGreetingBusinessName: (value) => { greetingBusinessName = value; },
    setInfobipContentType: (value) => { infobipContentType = value; },
    setResponseLanguage: transcriptionCoordinator.setResponseLanguage,
    setSession: (value) => { session = value; },
    wsReadyState: () => ws.readyState
  });

  const handleBinaryAudio = createInfobipMediaFrameHandler({
    audioLogCounters,
    bufferGeminiAudio,
    correlationId,
    getInfobipContentType: () => infobipContentType,
    getSession: () => session,
    isGeminiReadyForAudio: () => geminiBridge.isReadyForAudio(),
    isGeminiRebindInProgress: () => geminiBridge.isRebindInProgress(),
    logContext: LOG_CONTEXT,
    productionTraceMetadata,
    sendGeminiAudio,
    shouldLogFrameDetail,
    ws
  });

  bindInfobipMessageRouter({
    correlationId,
    getSession: () => session,
    handleBinaryAudio,
    logContext: LOG_CONTEXT,
    productionTraceMetadata,
    startRealtimeLoop,
    ws
  });

  bindMediaSocketConnectionLifecycle({
    cleanup,
    correlationId,
    currentTurnId: () => currentTurnId(),
    emitFinalSummary: ({ timestamp, turnId }) => {
      if (!session) return;
      flushQueuedSofiaVoiceAssistantTranscriptForVoker({
        callId: session.callId,
        reason: 'final_summary'
      });
      emitSofiaVoiceFinalSummaryVokerEvent({
        orgId: session.orgId,
        callId: session.callId,
        sessionId: session.sessionId,
        turnId,
        timestamp,
        modelName: GEMINI_LIVE_MODEL,
        language: transcriptionCoordinator.getResponseLanguage()
      });
    },
    finalizeReceptionistCall: async (closeReason) => {
      await finalizeSofiaReceptionistCall({
        session,
        identity: callerIdentity,
        closeReason
      });
    },
    getSession: () => session,
    logAudioSummary,
    logContext: LOG_CONTEXT,
    productionTraceMetadata,
    publishClosedLiveState: ({ code }) => {
      if (!session) return;
      void publishSofiaLiveCallState({
        session,
        status: code === 1000 ? 'ending' : 'failed',
        sofiaStatus: code === 1000 ? 'idle' : 'error',
        currentSafeAction: 'none',
        lastSafeEventAt: new Date().toISOString(),
        projectionEventType: 'sofia_runtime_milestone',
        writeAction: code === 1000 ? 'update' : 'fail',
      });
    },
    publishFailedLiveState: () => {
      if (!session) return;
      void publishSofiaLiveCallState({
        session,
        status: 'failed',
        sofiaStatus: 'error',
        currentSafeAction: 'none',
        lastSafeEventAt: new Date().toISOString(),
        projectionEventType: 'sofia_runtime_milestone',
        writeAction: 'fail',
      });
    },
    ws
  });
}
