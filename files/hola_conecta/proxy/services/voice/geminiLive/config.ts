import { SOFIA_VOICE_TRANSCRIPTION_ENABLED } from '../sofiaVoiceRuntimeConfig.ts';

export const SOFIA_OFFICIAL_VOICE_NAME = 'Despina';
export const GEMINI_LIVE_MODEL = process.env.SOFIA_GEMINI_LIVE_MODEL || 'models/gemini-3.1-flash-live-preview';
export const GEMINI_LIVE_WS_URL = flagEnabled('SOFIA_VOICE_MOCK_MODE') && process.env.SOFIA_GEMINI_LIVE_WS_URL
  ? process.env.SOFIA_GEMINI_LIVE_WS_URL
  : 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const INITIAL_GEMINI_DOMAIN = 'orchestrator';
export const INITIAL_CALL_HISTORY_SUMMARY = 'Call connected. No prior domain handoff summary is available.';
export const REBIND_AUDIO_BUFFER_MS = Number(process.env.SOFIA_GEMINI_REBIND_AUDIO_BUFFER_MS || 500);
export const REBIND_AUDIO_BUFFER_MAX_BYTES = Number(process.env.SOFIA_GEMINI_REBIND_AUDIO_BUFFER_MAX_BYTES || 32_000);
export const GEMINI_REBIND_SETUP_TIMEOUT_MS = Number(process.env.SOFIA_GEMINI_REBIND_SETUP_TIMEOUT_MS || 5000);
export const GEMINI_INPUT_TRANSCRIPTION_ENABLED = SOFIA_VOICE_TRANSCRIPTION_ENABLED;
export const GEMINI_OUTPUT_TRANSCRIPTION_ENABLED = SOFIA_VOICE_TRANSCRIPTION_ENABLED;
export const SOFIA_BUSINESS_INFO_GUARDRAIL_INSTRUCTION = [
  'BUSINESS FACTS GUARDRAIL: For office address, office location, hours, directions, parking, nearby landmarks, map links, phone, email, website, services, pricing, documents needed, appointment availability, walk-ins, languages, payment methods, refunds, balances, staff, or preparer availability, use lookup_business_info or the specialized booking/document tool before answering.',
  'If lookup_business_info returns a verified answer, answer only from that verified value.',
  'If it returns unavailable, say the verified answer is not available right now and offer to take a message or have someone follow up.',
  'For map links, lookup_business_info may return a followUpActionProposal. That is not a completed SMS. Ask the caller for consent, then use send_sms. Do not say a map link was sent unless send_sms returns sent or success.',
  'Never invent office addresses, directions, landmarks, hours, pricing, staff, preparers, policies, payment methods, languages, or business facts.'
].join(' ');

function flagEnabled(name: string): boolean {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

export function geminiLiveVoiceName(): string {
  const configured = process.env.SOFIA_VOICE_LIVE_VOICE_NAME;
  if (!configured?.trim()) {
    throw new Error('FATAL: SOFIA_VOICE_LIVE_VOICE_NAME must be explicitly set.');
  }
  const voiceName = configured.trim();
  if (voiceName !== SOFIA_OFFICIAL_VOICE_NAME) {
    throw new Error(`FATAL: Sofia official voice must remain ${SOFIA_OFFICIAL_VOICE_NAME}. SOFIA_VOICE_LIVE_VOICE_NAME is set to ${voiceName}.`);
  }
  return voiceName;
}

export function geminiLiveLanguageCode(): string {
  const code = process.env.SOFIA_VOICE_LIVE_LANGUAGE_CODE;
  if (!code?.trim()) {
    throw new Error('FATAL: SOFIA_VOICE_LIVE_LANGUAGE_CODE must be explicitly set.');
  }
  return code.trim();
}

type GeminiLiveSpeechConfig = {
  voiceConfig: {
    prebuiltVoiceConfig: {
      voiceName: string;
    };
  };
};

export function buildGeminiLiveSpeechConfig(): GeminiLiveSpeechConfig {
  return {
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: geminiLiveVoiceName()
      }
    }
  };
}

export function geminiLiveUrl(): string {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for Sofia Gemini Live voice bridge');
  const url = new URL(GEMINI_LIVE_WS_URL);
  url.searchParams.set('key', apiKey);
  return url.toString();
}

export function sanitizedGeminiLiveEndpoint(): string {
  const url = new URL(GEMINI_LIVE_WS_URL);
  url.search = '';
  return url.toString();
}

export function buildRealtimeAudioPayload(pcm16k: Buffer) {
  return {
    realtimeInput: {
      audio: {
        data: pcm16k.toString('base64'),
        mimeType: 'audio/pcm;rate=16000'
      }
    }
  };
}

export function sampleRateFromMimeType(mimeType: string | null, fallback: number): number {
  const match = String(mimeType || '').match(/rate=(\d+)/i);
  return match ? Number(match[1]) : fallback;
}

export function buildTemporalContext(timezone: string | null, now: Date = new Date()): string {
  const safeTimezone = timezone && timezone.trim() ? timezone.trim() : 'UTC';
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  }).format(now);
  return [
    `CURRENT DATE/TIME CONTEXT: Today is ${dateParts}.`,
    `Current local office time is ${timeParts}.`,
    `Office timezone is ${safeTimezone}.`,
    'Resolve tomorrow, weekdays, this week, next week, and caller-relative dates using this office timezone.'
  ].join(' ');
}
