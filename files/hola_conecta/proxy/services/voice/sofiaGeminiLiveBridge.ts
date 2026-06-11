import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { logError, logInfo, logWarn } from '../../utils/logger.js';
import {
  GEMINI_INPUT_TRANSCRIPTION_ENABLED,
  GEMINI_LIVE_MODEL,
  GEMINI_OUTPUT_TRANSCRIPTION_ENABLED,
  GEMINI_REBIND_SETUP_TIMEOUT_MS,
  INITIAL_GEMINI_DOMAIN,
  buildGeminiSeedPayload,
  buildGeminiSetupPayload,
  geminiLiveLanguageCode,
  geminiLiveUrl,
  geminiLiveVoiceName,
  getDomainConfig,
  normalizeGeminiDomain,
  sanitizedGeminiLiveEndpoint,
  validateDomainConfigTools,
  validateRawGeminiLiveSetupPayload
} from './infobipMediaWebSocketGemini.ts';
import { SOFIA_BILINGUAL_VOICE_STYLE_VERSION } from './sofiaVoiceLanguage.ts';
import {
  isGeminiInterrupted,
  isGeminiSetupComplete,
  isGeminiTurnComplete,
  readGeminiFunctionCalls,
  readGeminiInlineAudio,
  readGeminiInputTranscription,
  readGeminiOutputTranscription,
  readJsonFrame,
  type GeminiAudioTranscription,
  type GeminiFunctionCall
} from './infobipMediaWebSocketGeminiFrames.ts';
import { VOICE_TRANSCRIPT_CLOUD_LOG_ENABLED } from './sofiaVoiceRuntimeConfig.ts';
import type { GeminiDomain, GeminiInlineAudio } from './infobipMediaWebSocketGeminiTypes.ts';
import type { VoiceSession } from './voiceSessionTypes.ts';
import { buildGeminiSetupPayloadSchemaDump } from './geminiSetupPayloadSchemaDump.ts';
import { buildSofiaVoiceDebugJsonDump } from './sofiaVoiceDeepDebugLog.ts';
import { phoneLogSummary } from './voiceLogSanitizer.ts';
import { buildJsonPayloadShape, logJsonHandoff } from './sofiaVoiceJsonHandoffLogger.ts';

export type GeminiLiveSocket = WebSocket & {
  setupSent?: boolean;
  setupComplete?: boolean;
  seedSent?: boolean;
};

type HandoffBufferMetrics = {
  frames: number;
  bytes: number;
};

const GEMINI_SETUP_SCHEMA_DUMP_ENABLED = process.env.SOFIA_GEMINI_SETUP_SCHEMA_DUMP_ENABLED !== 'false';
const GEMINI_SETUP_ADAPTER_VERSION = 'gemini_live_setup_schema_dump_debug_v1';

export type SofiaGeminiLiveBridgeCallbacks = {
  clearOutboundAudioForInterruption: () => void;
  emitLocalDebugEvent: (event: string, metadata: Record<string, unknown>) => void;
  flushBufferedGeminiAudio: (input: { domain: GeminiDomain; generation: number; initialCallStart: boolean }) => void | Promise<void>;
  getCurrentSessionHistory: () => string;
  getHandoffBufferMetrics: () => HandoffBufferMetrics;
  getGreetingBusinessName: () => string;
  getBusinessKnowledgeContext: () => string;
  getIdentitySummary: () => string;
  getLanguageContext: () => string;
  getSession: () => VoiceSession | null;
  getTemporalContext: () => string;
  isClosed: () => boolean;
  onAudioReceived: (audio: GeminiInlineAudio, generation: number, domain: GeminiDomain) => void;
  onFatalClose: (code: number, reason: string) => void;
  onFunctionCall: (call: GeminiFunctionCall) => void;
  onInputTranscription: (transcription: GeminiAudioTranscription, generation: number, domain: GeminiDomain) => void;
  onInterrupted: () => void;
  onOutputTranscription: (transcription: GeminiAudioTranscription, generation: number, domain: GeminiDomain) => void;
  onTurnComplete: () => void;
};

export class SofiaGeminiLiveBridge {
  private activeGeminiDomain: GeminiDomain = INITIAL_GEMINI_DOMAIN;
  private degradedRecoveryAttempts = 0;
  private gemini: GeminiLiveSocket | null = null;
  private geminiGeneration = 0;
  private rebindInProgress = false;

  constructor(
    private readonly logContext: string,
    private readonly callbacks: SofiaGeminiLiveBridgeCallbacks
  ) {}

  getActiveDomain(): GeminiDomain {
    return this.activeGeminiDomain;
  }

  getActiveGeneration(): number {
    return this.geminiGeneration;
  }

  getSocket(): GeminiLiveSocket | null {
    return this.gemini;
  }

  isRebindInProgress(): boolean {
    return this.rebindInProgress;
  }

  setRebindInProgress(value: boolean): void {
    this.rebindInProgress = value;
  }

  isReadyForAudio(): boolean {
    return Boolean(
      this.gemini
      && this.gemini.readyState === WebSocket.OPEN
      && this.gemini.setupSent === true
      && this.gemini.setupComplete === true
      && !this.rebindInProgress
    );
  }

  sendRealtimeAudioPayload(payload: Record<string, unknown>): void {
    if (!this.gemini || !this.isReadyForAudio()) return;
    this.gemini.send(JSON.stringify(payload));
  }

  sendRealtimeTextPayload(text: string): boolean {
    const session = this.callbacks.getSession();
    if (!this.gemini || !this.isReadyForAudio() || !session) return false;
    const payload = {
      realtimeInput: {
        text
      }
    };
    this.gemini.send(JSON.stringify(payload));
    logInfo(this.logContext, 'voice.gemini.realtime_text_sent', {
      sessionId: session.sessionId,
      callId: session.callId,
      generation: this.geminiGeneration,
      domain: this.activeGeminiDomain,
      purpose: 'voice_language_context_update',
      textPreview: text.slice(0, 240)
    });
    return true;
  }

  closeActive(reason: string): void {
    if (this.gemini && this.gemini.readyState === WebSocket.OPEN) {
      this.gemini.close(1000, reason);
    }
  }

  connectToDomain(
    domain: string,
    historySummary: string,
    options: { initialCallStart?: boolean } = {}
  ): GeminiLiveSocket {
    const targetDomain = normalizeGeminiDomain(domain);
    const generation = this.geminiGeneration + 1;
    this.geminiGeneration = generation;
    this.activeGeminiDomain = targetDomain;
    this.rebindInProgress = true;
    const geminiWs = new WebSocket(geminiLiveUrl()) as GeminiLiveSocket;
    this.gemini = geminiWs;
    logInfo(this.logContext, 'voice.gemini.connecting', {
      generation,
      domain: targetDomain,
      model: GEMINI_LIVE_MODEL,
      endpoint: sanitizedGeminiLiveEndpoint()
    });
    const setupTimeout = setTimeout(() => {
      this.handleGeminiRebindFailure(generation, targetDomain, 'setup_complete_timeout');
    }, GEMINI_REBIND_SETUP_TIMEOUT_MS);

    geminiWs.on('open', () => {
      const session = this.callbacks.getSession();
      if (!session || this.callbacks.isClosed() || generation !== this.geminiGeneration) return;
      logInfo(this.logContext, 'voice.gemini.connected', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        endpoint: sanitizedGeminiLiveEndpoint()
      });
      const domainConfig = getDomainConfig(targetDomain);
      const toolValidation = validateDomainConfigTools(domainConfig);
      logInfo(this.logContext, 'voice.domain.initialized', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: domainConfig.domain,
        instructionSource: 'proxy/sofia/agents',
        toolNames: toolValidation.toolNames
      });
      logInfo(this.logContext, 'voice.domain.tools_exposed', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: domainConfig.domain,
        toolNames: toolValidation.toolNames,
        duplicateToolNames: toolValidation.duplicateToolNames,
        missingHandlerNames: toolValidation.missingHandlerNames,
        handlerNamesNotDeclared: toolValidation.handlerNamesNotDeclared,
        invalidDeclarations: toolValidation.invalidDeclarations,
        domainConfigDump: buildSofiaVoiceDebugJsonDump({
          label: 'sofia_domain_config_tools_and_instruction_shape',
          value: domainConfig
        })
      });
      logInfo(this.logContext, 'voice.domain.instruction_selected', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: domainConfig.domain,
        instructionSource: 'proxy/sofia/agents',
        instructionLength: domainConfig.systemInstruction.length
      });
      if (!toolValidation.ok) {
        const validationError = new Error(`Invalid Gemini Live tool declarations: ${JSON.stringify({
          duplicateToolNames: toolValidation.duplicateToolNames,
          missingHandlerNames: toolValidation.missingHandlerNames,
          invalidDeclarations: toolValidation.invalidDeclarations
        })}`);
        logError(this.logContext, 'voice.gemini.setup_payload.invalid', validationError, {
          sessionId: session.sessionId,
          callId: session.callId,
          generation,
          domain: targetDomain,
          validationDump: buildSofiaVoiceDebugJsonDump({
            label: 'gemini_live_tool_declaration_validation_failure',
            value: {
              toolValidation,
              domainConfig
            }
          })
        });
        geminiWs.close(1008, 'Invalid Sofia Live tool declarations');
        return;
      }
      const setupPayload = buildGeminiSetupPayload(targetDomain, {
        historySummary,
        greetingBusinessName: this.callbacks.getGreetingBusinessName(),
        businessKnowledgeContext: this.callbacks.getBusinessKnowledgeContext(),
        identitySummary: this.callbacks.getIdentitySummary(),
        voiceLanguageContext: this.callbacks.getLanguageContext(),
        temporalContext: this.callbacks.getTemporalContext(),
        ...(options.initialCallStart !== undefined ? { initialCallStart: options.initialCallStart } : {})
      });
      const requestedVoiceName = geminiLiveVoiceName();
      const requestedLanguageCode = geminiLiveLanguageCode();
      const rawSetupValidation = validateRawGeminiLiveSetupPayload(setupPayload);
      if (!rawSetupValidation.ok) {
        const validationError = new Error(`Invalid raw Gemini Live setup payload fields: ${rawSetupValidation.invalidFields.join(', ')}`);
        logError(this.logContext, 'voice.gemini.setup_payload.invalid_raw_fields', validationError, {
          sessionId: session.sessionId,
          callId: session.callId,
          generation,
          domain: targetDomain,
          invalidFields: rawSetupValidation.invalidFields,
          topLevelKeys: rawSetupValidation.topLevelKeys,
          setupKeys: rawSetupValidation.setupKeys,
          generationConfigKeys: rawSetupValidation.generationConfigKeys,
          speechConfigKeys: rawSetupValidation.speechConfigKeys,
          requestedVoiceName,
          requestedLanguageCode,
          voiceSelectionConfiguredInRawSetup: true,
          sanitizedRejectionReason: validationError.message,
          setupPayloadDump: buildSofiaVoiceDebugJsonDump({
            label: 'invalid_raw_gemini_live_setup_payload',
            value: setupPayload
          })
        });
        geminiWs.close(1008, 'Invalid raw Gemini Live setup payload');
        return;
      }
      logInfo(this.logContext, 'voice.language.prompt_context_applied', {
        sessionId: session.sessionId,
        callId: session.callId,
        turnId: `${session.callId}:${session.turnNumber}`,
        ...phoneLogSummary(session.fromPhone, 'from'),
        generation,
        domain: targetDomain,
        currentLanguage: session.languageState.currentLanguage,
        previousLanguage: session.languageState.previousLanguage,
        detectedLanguage: session.languageState.detectedLanguage,
        requestedLanguage: session.languageState.requestedLanguage,
        switchReason: session.languageState.languageSwitchReason,
        source: 'system_instruction',
        voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
        promptContextPreview: this.callbacks.getLanguageContext().slice(0, 220)
      });
      if (GEMINI_SETUP_SCHEMA_DUMP_ENABLED) {
        logInfo(this.logContext, 'voice.gemini.setup_payload.schema_dump', {
          sessionId: session.sessionId,
          callId: session.callId,
          generation,
          domain: targetDomain,
          schemaDumpDebugEnabled: true,
          setupSchemaDump: buildGeminiSetupPayloadSchemaDump({
            adapterVersion: GEMINI_SETUP_ADAPTER_VERSION,
            endpoint: sanitizedGeminiLiveEndpoint(),
            payload: setupPayload
          })
        });
      }
      logInfo(this.logContext, 'voice.gemini.setup_payload.built', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        payloadShapeVersion: 'gemini_live_setup_v1beta_bidi_generate_content',
        topLevelKeys: rawSetupValidation.topLevelKeys,
        setupKeys: rawSetupValidation.setupKeys,
        generationConfigKeys: rawSetupValidation.generationConfigKeys,
        speechConfigKeys: rawSetupValidation.speechConfigKeys,
        model: GEMINI_LIVE_MODEL,
        endpoint: sanitizedGeminiLiveEndpoint(),
        responseModalities: ['AUDIO'],
        requestedVoiceName,
        requestedLanguageCode,
        initialResponseLanguageCode: requestedLanguageCode,
        languageContext: this.callbacks.getLanguageContext(),
        voiceSelectionConfiguredInRawSetup: true,
        voiceSelectionPayloadPath: 'setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName',
        languageCodeConfiguredInRawSetup: false,
        languageCodeSentToGemini: false,
        languageControl: 'system_instruction_and_session_language_state',
        languageEnforcedThroughSystemInstruction: true,
        voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
        instructionSource: 'proxy/sofia/agents',
        toolNames: toolValidation.toolNames,
        inputAudioMimeType: 'audio/pcm;rate=16000',
        outputAudioFormat: 'audio/pcm;rate=24000'
      });
      logJsonHandoff({
        logContext: this.logContext,
        event: 'voice.json.gemini.setup_sender_to_receiver',
        sender: 'Sofia',
        converter: 'Gemini Live setup payload builder',
        receiver: 'Gemini Live',
        direction: 'sender_to_receiver',
        stage: 'setup_payload_send',
        status: 'sent',
        sessionId: session.sessionId,
        callId: session.callId,
        orgId: session.orgId,
        provider: 'gemini',
        payloadShape: buildJsonPayloadShape(setupPayload),
        metadata: {
          generation,
          domain: targetDomain,
          model: GEMINI_LIVE_MODEL,
          endpoint: sanitizedGeminiLiveEndpoint(),
          toolNames: toolValidation.toolNames,
          voiceSelectionPayloadPath: 'setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName'
        }
      });
      geminiWs.send(JSON.stringify(setupPayload));
      geminiWs.setupSent = true;
      logInfo(this.logContext, 'voice.gemini.setup_sent', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        model: GEMINI_LIVE_MODEL,
        responseModalities: ['AUDIO'],
        initialResponseLanguageCode: geminiLiveLanguageCode(),
        languageContext: this.callbacks.getLanguageContext(),
        endpoint: sanitizedGeminiLiveEndpoint(),
        payloadShapeVersion: 'gemini_live_setup_v1beta_bidi_generate_content',
        topLevelKeys: rawSetupValidation.topLevelKeys,
        setupKeys: rawSetupValidation.setupKeys,
        generationConfigKeys: rawSetupValidation.generationConfigKeys,
        speechConfigKeys: rawSetupValidation.speechConfigKeys,
        requestedVoiceName,
        requestedLanguageCode,
        voiceSelectionConfiguredInRawSetup: true,
        voiceSelectionPayloadPath: 'setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName',
        languageCodeConfiguredInRawSetup: false,
        languageCodeSentToGemini: false,
        languageControl: 'system_instruction_and_session_language_state',
        languageEnforcedThroughSystemInstruction: true,
        voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
        inputTranscriptionEnabled: GEMINI_INPUT_TRANSCRIPTION_ENABLED,
        outputTranscriptionEnabled: GEMINI_OUTPUT_TRANSCRIPTION_ENABLED,
        transcriptCloudLogEnabled: VOICE_TRANSCRIPT_CLOUD_LOG_ENABLED,
        instructionSource: 'proxy/sofia/agents',
        toolNames: toolValidation.toolNames
      });
    });

    geminiWs.on('message', (data) => {
      this.handleGeminiMessage(geminiWs, data, generation, targetDomain, historySummary, options, setupTimeout);
    });

    geminiWs.on('close', (code, reason) => {
      clearTimeout(setupTimeout);
      const session = this.callbacks.getSession();
      logInfo(this.logContext, 'voice.gemini.closed', {
        sessionId: session?.sessionId || null,
        callId: session?.callId || null,
        generation,
        activeGeneration: this.geminiGeneration,
        domain: targetDomain,
        code,
        reason: reason.toString(),
        setupCompleteReceived: geminiWs.setupComplete === true
      });
      logInfo(this.logContext, 'voice.gemini.close', {
        sessionId: session?.sessionId || null,
        callId: session?.callId || null,
        generation,
        activeGeneration: this.geminiGeneration,
        domain: targetDomain,
        code,
        reason: reason.toString(),
        setupCompleteReceived: geminiWs.setupComplete === true
      });
      if (generation !== this.geminiGeneration) return;
      this.handleGeminiRebindFailure(generation, targetDomain, `socket_closed_${code}`);
    });

    geminiWs.on('error', (error) => {
      const session = this.callbacks.getSession();
      logError(this.logContext, 'voice.gemini.error', error, {
        sessionId: session?.sessionId || null,
        callId: session?.callId || null,
        generation,
        activeGeneration: this.geminiGeneration,
        domain: targetDomain
      });
    });

    return geminiWs;
  }

  private handleGeminiMessage(
    geminiWs: GeminiLiveSocket,
    data: RawData,
    generation: number,
    targetDomain: GeminiDomain,
    historySummary: string,
    options: { initialCallStart?: boolean },
    setupTimeout: NodeJS.Timeout
  ): void {
    const message = readJsonFrame(data);
    const session = this.callbacks.getSession();
    if (!message || !session || generation !== this.geminiGeneration) return;
    logJsonHandoff({
      logContext: this.logContext,
      event: 'voice.json.gemini.server_frame_received',
      sender: 'Gemini Live',
      converter: 'Gemini Live server frame parser',
      receiver: 'SofiaGeminiLiveBridge',
      direction: 'sender_to_converter',
      stage: 'server_frame_received',
      status: 'received',
      sessionId: session.sessionId,
      callId: session.callId,
      orgId: session.orgId,
      provider: 'gemini',
      payloadShape: buildJsonPayloadShape(message),
      payloadBytes: Buffer.isBuffer(data) ? data.length : Buffer.from(data as ArrayBuffer).length,
      metadata: {
        generation,
        domain: targetDomain,
        setupCompleteFrame: isGeminiSetupComplete(message),
        turnCompleteFrame: isGeminiTurnComplete(message)
      }
    });
    logInfo(this.logContext, 'voice.gemini.server_frame.shape_dump', {
      sessionId: session.sessionId,
      callId: session.callId,
      generation,
      domain: targetDomain,
      serverFrameDump: buildSofiaVoiceDebugJsonDump({
        label: 'gemini_live_server_frame',
        value: message
      })
    });

    if (typeof message === 'object' && message !== null && 'goAway' in message) {
      logWarn(this.logContext, 'voice.gemini.goaway_received', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        goAwayDump: buildSofiaVoiceDebugJsonDump({
          label: 'gemini_live_goaway',
          value: message.goAway
        })
      });
    }

    if (isGeminiSetupComplete(message)) {
      clearTimeout(setupTimeout);
      geminiWs.setupComplete = true;
      geminiWs.send(JSON.stringify(buildGeminiSeedPayload(targetDomain, historySummary, {
        ...options,
        identitySummary: this.callbacks.getIdentitySummary(),
        voiceLanguageContext: this.callbacks.getLanguageContext(),
        temporalContext: this.callbacks.getTemporalContext()
      })));
      geminiWs.seedSent = true;
      logInfo(this.logContext, 'voice.gemini.seed_sent', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        initialCallStart: options.initialCallStart === true
      });
      this.rebindInProgress = false;
      this.degradedRecoveryAttempts = 0;
      const handoffMetrics = this.callbacks.getHandoffBufferMetrics();
      logInfo(this.logContext, 'voice.gemini.setup_complete', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        requestedVoiceName: geminiLiveVoiceName(),
        requestedLanguageCode: geminiLiveLanguageCode(),
        voiceSelectionConfiguredInRawSetup: true,
        languageCodeConfiguredInRawSetup: false,
        languageCodeSentToGemini: false,
        languageControl: 'system_instruction_and_session_language_state',
        voiceStyleInstructionVersion: SOFIA_BILINGUAL_VOICE_STYLE_VERSION,
        setupCompleteReceived: true,
        handoffBufferFrames: handoffMetrics.frames,
        handoffBufferBytes: handoffMetrics.bytes
      });
      this.callbacks.emitLocalDebugEvent('gemini_setup_complete', {
        generation,
        domain: targetDomain,
        handoffBufferFrames: handoffMetrics.frames,
        handoffBufferBytes: handoffMetrics.bytes
      });
      void Promise.resolve(this.callbacks.flushBufferedGeminiAudio({
        domain: targetDomain,
        generation,
        initialCallStart: options.initialCallStart === true
      })).catch((error) => {
        logError(this.logContext, 'voice.gemini.audio_buffer_flush_failed', error, {
          sessionId: session.sessionId,
          callId: session.callId,
          generation,
          domain: targetDomain,
          initialCallStart: options.initialCallStart === true
        });
      });
    }

    if (isGeminiInterrupted(message)) {
      logInfo(this.logContext, 'voice.gemini.interruption_received', {
        sessionId: session.sessionId,
        callId: session.callId,
        orgId: session.orgId,
        generation,
        domain: targetDomain,
        activeDomain: this.getActiveDomain(),
        action: 'clear_outbound_audio_for_barge_in',
        payloadShape: buildJsonPayloadShape(message),
        serverFrameDump: buildSofiaVoiceDebugJsonDump({
          label: 'gemini_live_interruption_frame',
          value: message,
          note: 'Raw audio/base64 is redacted; this dump is for correlating Gemini interruption with Infobip clear-buffer and outbound audio timing.'
        }),
        rawAudioLogged: false,
        contentsLogged: false
      });
      this.callbacks.clearOutboundAudioForInterruption();
      this.callbacks.onInterrupted();
    }

    if (isGeminiTurnComplete(message)) {
      this.callbacks.onTurnComplete();
    }

    const functionCalls = readGeminiFunctionCalls(message);
    if (functionCalls.length) {
      logInfo(this.logContext, 'voice.gemini.tool_call.shape_dump', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        functionCallCount: functionCalls.length,
        functionCallsDump: buildSofiaVoiceDebugJsonDump({
          label: 'gemini_live_function_calls',
          value: functionCalls
        })
      });
    }
    for (const functionCall of functionCalls) {
      logInfo(this.logContext, 'voice.gemini.tool_call.received', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        toolCallId: functionCall.id,
        toolName: functionCall.name
      });
      this.callbacks.onFunctionCall(functionCall);
    }

    const inputTranscription = readGeminiInputTranscription(message);
    if (inputTranscription && GEMINI_INPUT_TRANSCRIPTION_ENABLED) {
      this.callbacks.onInputTranscription(inputTranscription, generation, targetDomain);
    }

    const outputTranscription = readGeminiOutputTranscription(message);
    if (outputTranscription && GEMINI_OUTPUT_TRANSCRIPTION_ENABLED) {
      this.callbacks.onOutputTranscription(outputTranscription, generation, targetDomain);
    }

    const audioParts = readGeminiInlineAudio(message);
    if (audioParts.length) {
      logInfo(this.logContext, 'voice.gemini.audio.shape_dump', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        audioPartCount: audioParts.length,
        audioPartsDump: buildSofiaVoiceDebugJsonDump({
          label: 'gemini_live_inline_audio_parts',
          value: audioParts
        })
      });
    }
    for (const audio of audioParts) {
      this.callbacks.emitLocalDebugEvent('gemini_audio_received', {
        generation,
        domain: targetDomain,
        mimeType: audio.mimeType,
        byteLength: Buffer.byteLength(audio.data, 'base64')
      });
      logInfo(this.logContext, 'voice.gemini.audio.received', {
        sessionId: session.sessionId,
        callId: session.callId,
        generation,
        domain: targetDomain,
        mimeType: audio.mimeType,
        byteLength: Buffer.byteLength(audio.data, 'base64')
      });
      this.callbacks.onAudioReceived(audio, generation, targetDomain);
    }
  }

  private handleGeminiRebindFailure(generation: number, targetDomain: GeminiDomain, reason: string): void {
    if (this.callbacks.isClosed() || generation !== this.geminiGeneration) return;
    const session = this.callbacks.getSession();
    this.rebindInProgress = false;
    logWarn(this.logContext, 'voice.gemini.rebind_failed', {
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      generation,
      domain: targetDomain,
      reason,
      degradedRecoveryAttempts: this.degradedRecoveryAttempts
    });

    if (this.degradedRecoveryAttempts >= 1 || targetDomain === INITIAL_GEMINI_DOMAIN) {
      this.callbacks.onFatalClose(1011, 'Gemini Live degraded recovery failed');
      return;
    }

    this.degradedRecoveryAttempts += 1;
    const failedGemini = this.gemini;
    const degradedSummary = [
      'Service degraded: Sofia failed to initialize the requested specialized Gemini domain.',
      `Failed domain: ${targetDomain}. Failure reason: ${reason}.`,
      'Resume as the orchestrator, apologize briefly, continue routing, and avoid claiming the specialized action completed.',
      this.callbacks.getCurrentSessionHistory()
    ].join(' ');
    this.connectToDomain(INITIAL_GEMINI_DOMAIN, degradedSummary);
    if (failedGemini && failedGemini.readyState === WebSocket.OPEN) {
      failedGemini.close(1011, `rebind_failed_${targetDomain}`);
    } else if (failedGemini && failedGemini.readyState === WebSocket.CONNECTING) {
      failedGemini.close(1011, `rebind_failed_${targetDomain}`);
    }
  }
}
