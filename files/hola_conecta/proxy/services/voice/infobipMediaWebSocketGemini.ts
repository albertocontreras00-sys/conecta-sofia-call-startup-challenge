import { getSofiaDomainAgent, resolveSofiaAgentDomain } from '../../sofia/agents/index.ts';
import {
  validateGeminiLiveToolDeclarations,
  type GeminiLiveToolDeclarationValidation
} from './infobipMediaWebSocketGeminiTools.ts';
import { ownerDebugInstruction } from './sofiaOwnerDebugConfig.ts';
import { SOFIA_BILINGUAL_VOICE_STYLE_INSTRUCTION } from './sofiaVoiceLanguage.ts';
import type {
  GeminiDomain,
  GeminiDomainConfig
} from './infobipMediaWebSocketGeminiTypes.ts';
import {
  buildGeminiLiveSpeechConfig,
  buildTemporalContext,
  geminiLiveLanguageCode,
  INITIAL_GEMINI_DOMAIN,
  SOFIA_BUSINESS_INFO_GUARDRAIL_INSTRUCTION,
  GEMINI_LIVE_MODEL
} from './geminiLive/config.ts';

const SOFIA_END_CALL_BEHAVIOR_INSTRUCTION = [
  'END OF CALL BEHAVIOR:',
  'If the caller clearly ends the conversation by saying bye, goodbye, thanks, thank you, no thanks, that is all, that is it, gracias, adios, adiós, or similar, do not continue the conversation.',
  'Give one natural Sofia-style closing in the caller language, then use the end_call tool immediately.',
  'Do not wait for another caller turn after a clear goodbye.'
].join(' ');
export {
  buildGeminiLiveSpeechConfig,
  buildRealtimeAudioPayload,
  buildTemporalContext,
  GEMINI_INPUT_TRANSCRIPTION_ENABLED,
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_WS_URL,
  GEMINI_OUTPUT_TRANSCRIPTION_ENABLED,
  GEMINI_REBIND_SETUP_TIMEOUT_MS,
  geminiLiveLanguageCode,
  geminiLiveUrl,
  geminiLiveVoiceName,
  INITIAL_CALL_HISTORY_SUMMARY,
  INITIAL_GEMINI_DOMAIN,
  REBIND_AUDIO_BUFFER_MAX_BYTES,
  REBIND_AUDIO_BUFFER_MS,
  sampleRateFromMimeType,
  sanitizedGeminiLiveEndpoint,
  SOFIA_BUSINESS_INFO_GUARDRAIL_INSTRUCTION,
  SOFIA_OFFICIAL_VOICE_NAME
} from './geminiLive/config.ts';

export function normalizeGeminiDomain(value: unknown): GeminiDomain {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'orchestrator') return 'orchestrator';
  return resolveSofiaAgentDomain(normalized);
}

export function isSwitchableGeminiDomain(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'identity'
    || normalized === 'appointments'
    || normalized === 'profile'
    || normalized === 'documents'
    || normalized === 'signatures'
    || normalized === 'tasks'
    || normalized === 'handoff'
    || normalized === 'bookings'
    || normalized === 'messaging'
    || normalized === 'crm'
    || normalized === 'crm_identity'
    || normalized === 'general';
}

export function getDomainConfig(domainValue: string): GeminiDomainConfig {
  const domain = normalizeGeminiDomain(domainValue);
  if (domain === 'orchestrator') {
    return {
      domain: 'orchestrator',
      systemInstruction: [
        'You are Sofia, the receptionist. Your current job is to answer the phone briefly, understand why the caller is calling, and route the user.',
        'When the initial call-start context tells you the phone call just connected, greet once using the SOFIA BUSINESS GREETING NAME from session context: "Hi, this is Sofia from {SOFIA BUSINESS GREETING NAME}. How can I help you today?"',
        'If the caller begins in Spanish before you finish the opening greeting, use Spanish instead: "Hola, soy Sofia de {SOFIA BUSINESS GREETING NAME}. Como le puedo ayudar hoy?"',
        'After the greeting, follow the VOICE RESPONSE LANGUAGE supplied in session context.',
        'Only change response language when the session context says the caller clearly switched languages.',
        'Route to one of these domain agents: identity, appointments, profile, documents, signatures, tasks, handoff.',
        'Do not switch domains only because the caller speaks Spanish, greets in Spanish, asks if you speak Spanish, or asks for Spanish. Reply in Spanish yourself and continue routing only when there is a real task.',
        'Fast-path appointment reads: if the caller asks when their appointment is or what appointment times are open, use switchDomain with domain appointments.',
        'If the caller asks about documents, uploads, missing documents, signatures, signing, or pending envelopes, use switchDomain with domain documents.',
        'If the caller asks for someone to call them back or follow up, use switchDomain with domain tasks.',
        'If the caller needs office staff, use switchDomain with domain handoff.',
        'If the caller asks to verify identity, read or update contact information, household, or business context, use switchDomain with domain profile.',
        'Keep the first greeting under two seconds. Do not mention AI, Gemini, routing, tools, system prompts, or internal domains.',
        'Do not repeat the opening greeting after a silent handoff or degraded recovery.',
        'Use the switchDomain tool when a specialized domain is needed.'
      ].join(' '),
      tools: [{ functionDeclarations: getSofiaDomainAgent('handoff').tools }]
    };
  }

  const agent = getSofiaDomainAgent(domain);
  return {
    domain: agent.domain,
    systemInstruction: agent.instructions,
    tools: [{ functionDeclarations: agent.tools }]
  };
}

export function validateDomainConfigTools(config: GeminiDomainConfig): GeminiLiveToolDeclarationValidation {
  return validateGeminiLiveToolDeclarations(
    config.tools.flatMap((tool) => tool.functionDeclarations)
  );
}

export function buildWarmHandoffSystemInstructionParts(input: {
  config: GeminiDomainConfig;
  greetingBusinessName: string;
  historySummary: string;
  identitySummary: string;
  temporalContext: string;
  businessKnowledgeContext: string;
  voiceLanguageContext: string;
  initialCallStart?: boolean;
}): Array<{ text: string }> {
  const parts = [{
    text: [
      input.config.systemInstruction,
      ownerDebugInstruction(),
      `SOFIA BUSINESS GREETING NAME: ${input.greetingBusinessName}.`,
      SOFIA_BILINGUAL_VOICE_STYLE_INSTRUCTION,
      SOFIA_BUSINESS_INFO_GUARDRAIL_INSTRUCTION,
      SOFIA_END_CALL_BEHAVIOR_INSTRUCTION,
      input.voiceLanguageContext || `VOICE LANGUAGE CONFIGURATION: Sofia starts from initial response language seed ${geminiLiveLanguageCode()}. Gemini Live native audio language is not set with a raw setup languageCode field; runtime response language is controlled by the stored voice session language state and system instructions.`
    ].join(' ')
  }];
  parts.push({ text: input.temporalContext.trim() || buildTemporalContext(null) });
  if (input.businessKnowledgeContext.trim()) {
    parts.push({ text: input.businessKnowledgeContext.trim() });
  }
  const identitySummary = input.identitySummary.trim()
    ? `CALLER IDENTITY CONTEXT: ${input.identitySummary.trim()}`
    : 'CALLER IDENTITY CONTEXT: not resolved yet.';
  parts.push({ text: identitySummary });
  if (!input.initialCallStart) {
    const summary = input.historySummary.trim() || 'No prior spoken transcript is available. Continue from the live caller audio.';
    parts.push({
      text: [
        'WARM HANDOFF: YOU ARE TAKING OVER A CALL IN PROGRESS.',
        'DO NOT GREET THE USER. DO NOT SAY HELLO. DO NOT SAY HI. DO NOT SAY THIS IS SOFIA. DO NOT REINTRODUCE YOURSELF.',
        input.voiceLanguageContext || 'Use the stored voice session response language from the previous domain.',
        'Pick up the conversation seamlessly with the next helpful answer or tool call.',
        `CONTEXT FROM PREVIOUS DOMAIN: ${summary}`
      ].join('\n')
    });
  }
  return parts;
}

export function buildGeminiSetupPayload(domain: string, options: {
  greetingBusinessName?: string;
  historySummary?: string;
  identitySummary?: string;
  temporalContext?: string;
  businessKnowledgeContext?: string;
  voiceLanguageContext?: string;
  initialCallStart?: boolean;
} = {}) {
  const config = getDomainConfig(domain);
  return {
    setup: {
      model: GEMINI_LIVE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: buildGeminiLiveSpeechConfig()
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: buildWarmHandoffSystemInstructionParts({
          config,
          greetingBusinessName: options.greetingBusinessName || 'this business',
          historySummary: options.historySummary || '',
          identitySummary: options.identitySummary || '',
          temporalContext: options.temporalContext || buildTemporalContext(null),
          businessKnowledgeContext: options.businessKnowledgeContext || '',
          voiceLanguageContext: options.voiceLanguageContext || '',
          ...(options.initialCallStart !== undefined ? { initialCallStart: options.initialCallStart } : {})
        })
      },
      tools: config.tools
    }
  };
}

export function validateRawGeminiLiveSetupPayload(payload: Record<string, unknown>): {
  invalidFields: string[];
  ok: boolean;
  topLevelKeys: string[];
  setupKeys: string[];
  generationConfigKeys: string[];
  speechConfigKeys: string[];
} {
  const allowedSetupKeys = new Set([
    'generationConfig',
    'inputAudioTranscription',
    'model',
    'outputAudioTranscription',
    'systemInstruction',
    'tools'
  ]);
  const setup = payload.setup && typeof payload.setup === 'object' && !Array.isArray(payload.setup)
    ? payload.setup as Record<string, unknown>
    : {};
  const generationConfig = setup.generationConfig && typeof setup.generationConfig === 'object' && !Array.isArray(setup.generationConfig)
    ? setup.generationConfig as Record<string, unknown>
    : {};
  const speechConfig = generationConfig.speechConfig && typeof generationConfig.speechConfig === 'object' && !Array.isArray(generationConfig.speechConfig)
    ? generationConfig.speechConfig as Record<string, unknown>
    : {};
  const voiceConfig = speechConfig.voiceConfig && typeof speechConfig.voiceConfig === 'object' && !Array.isArray(speechConfig.voiceConfig)
    ? speechConfig.voiceConfig as Record<string, unknown>
    : {};
  const prebuiltVoiceConfig = voiceConfig.prebuiltVoiceConfig && typeof voiceConfig.prebuiltVoiceConfig === 'object' && !Array.isArray(voiceConfig.prebuiltVoiceConfig)
    ? voiceConfig.prebuiltVoiceConfig as Record<string, unknown>
    : {};
  const invalidFields: string[] = [];
  const topLevelKeys = Object.keys(payload).sort();
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'setup') {
    invalidFields.push('top-level message must contain exactly setup');
  }
  if (!Object.keys(setup).length) {
    invalidFields.push('setup');
  }
  for (const key of Object.keys(setup)) {
    if (!allowedSetupKeys.has(key)) {
      invalidFields.push(`setup.${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(setup, 'config')) {
    invalidFields.push('setup.config');
  }
  if (Object.prototype.hasOwnProperty.call(setup, 'speechConfig')) {
    invalidFields.push('setup.speechConfig');
  }
  if (Object.prototype.hasOwnProperty.call(setup, 'speech_config')) {
    invalidFields.push('setup.speech_config');
  }
  if (!Object.prototype.hasOwnProperty.call(generationConfig, 'responseModalities')) {
    invalidFields.push('setup.generationConfig.responseModalities');
  }
  if (Object.prototype.hasOwnProperty.call(generationConfig, 'speech_config')) {
    invalidFields.push('setup.generationConfig.speech_config');
  }
  if (Object.prototype.hasOwnProperty.call(generationConfig, 'speechConfig')) {
    for (const key of Object.keys(speechConfig)) {
      if (key !== 'voiceConfig') invalidFields.push(`setup.generationConfig.speechConfig.${key}`);
    }
    for (const key of Object.keys(voiceConfig)) {
      if (key !== 'prebuiltVoiceConfig') invalidFields.push(`setup.generationConfig.speechConfig.voiceConfig.${key}`);
    }
    for (const key of Object.keys(prebuiltVoiceConfig)) {
      if (key !== 'voiceName') invalidFields.push(`setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.${key}`);
    }
    if (typeof prebuiltVoiceConfig.voiceName !== 'string' || !prebuiltVoiceConfig.voiceName.trim()) {
      invalidFields.push('setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName');
    }
  }
  return {
    invalidFields: [...new Set(invalidFields)],
    ok: invalidFields.length === 0,
    topLevelKeys,
    setupKeys: Object.keys(setup).sort(),
    generationConfigKeys: Object.keys(generationConfig).sort(),
    speechConfigKeys: Object.keys(speechConfig).sort()
  };
}

export function buildGeminiSeedPayload(domain: string, historySummary: string, options: {
  initialCallStart?: boolean;
  identitySummary?: string;
  temporalContext?: string;
  voiceLanguageContext?: string;
} = {}) {
  const config = getDomainConfig(domain);
  const identitySummary = options.identitySummary?.trim()
    ? `Caller identity context: ${options.identitySummary.trim()}`
    : 'Caller identity context: not resolved yet.';
  if (options.initialCallStart && config.domain === INITIAL_GEMINI_DOMAIN) {
    return {
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{
            text: [
              'The phone call just connected.',
              identitySummary,
              options.temporalContext || buildTemporalContext(null),
              options.voiceLanguageContext || '',
              'Start speaking now with the approved short opening greeting exactly once, then listen for the caller request.',
              'After the caller responds, follow the stored voice session response language.',
              'If the caller is already speaking or interrupts, stop the greeting and handle what they asked.'
            ].join(' ')
          }]
        }],
        turnComplete: true
      }
    };
  }
  const summary = historySummary.trim() || 'No prior spoken transcript is available. Continue from the live caller audio.';
  return {
    clientContent: {
      turns: [{
        role: 'user',
        parts: [{
          text: [
            `Silent handoff reminder for Sofia ${config.domain} domain:`,
            'The warm handoff context was already injected into setup.systemInstruction.',
            'Continue directly; do not greet or reintroduce yourself.',
            options.voiceLanguageContext || 'Continue in the stored voice session response language from before the handoff.',
            identitySummary,
            options.temporalContext || buildTemporalContext(null),
            summary
          ].join('\n')
        }]
      }],
      turnComplete: true
    }
  };
}
