import { logInfo, logWarn } from '../../utils/logger.js';
import { buildConectaVokerEventPayload, type BuildConectaVokerEventInput } from './vokerEventPayloadService.ts';
import type { VokerVoiceMessage } from '../voice/observability/vokerMessageTypes.ts';

type VokerFingerprintResponse = {
  fingerprint_id?: string;
};

const LOG_CONTEXT = 'vokerObservabilityService';
const DEFAULT_BASE_URL = 'https://evals.voker.ai';
let fingerprintPromise: Promise<string> | null = null;
let missingConfigWarningLogged = false;

function trimEnv(name: string): string {
  return String(process.env[name] || '').trim();
}

function enabled(): boolean {
  return trimEnv('SOFIA_VOKER_OBSERVABILITY_ENABLED').toLowerCase() === 'true';
}

function apiKey(): string {
  return trimEnv('VOKER_API_KEY');
}

function baseUrl(): string {
  return (trimEnv('VOKER_API_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function timeoutMs(): number {
  const value = Number(trimEnv('SOFIA_VOKER_TIMEOUT_MS') || 3000);
  return Number.isFinite(value) && value > 0 ? value : 3000;
}

export function isVokerObservabilityEnabled(): boolean {
  if (!enabled()) return false;
  if (apiKey()) return true;
  if (!missingConfigWarningLogged) {
    missingConfigWarningLogged = true;
    logWarn(LOG_CONTEXT, 'voker.observability.config_missing', {
      missing: ['VOKER_API_KEY'],
      action: 'voker_send_skipped'
    });
  }
  return false;
}

async function vokerFetch(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());
  try {
    return await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function createFingerprint(): Promise<string> {
  const response = await vokerFetch('/api/v1/fingerprints', {
    method: 'PUT',
    body: JSON.stringify({
      language: 'typescript',
      language_version: process.version,
      system: `${process.platform}/${process.arch}`,
      voker_sdk_version: 'api-direct',
      all_packages: {
        node: process.version
      },
      git_branch: trimEnv('GIT_BRANCH') || trimEnv('K_REVISION') || undefined,
      git_commit_hash: trimEnv('GIT_COMMIT_SHA') || trimEnv('COMMIT_SHA') || undefined
    })
  });
  const body = await response.json().catch(() => null) as VokerFingerprintResponse | null;
  if (!response.ok || !body?.fingerprint_id) {
    throw new Error(`Voker fingerprint create failed: ${response.status}`);
  }
  return body.fingerprint_id;
}

async function getFingerprintId(): Promise<string> {
  const configured = trimEnv('VOKER_FINGERPRINT_ID');
  if (configured) return configured;
  if (!fingerprintPromise) {
    fingerprintPromise = createFingerprint().catch((error) => {
      fingerprintPromise = null;
      throw error;
    });
  }
  return fingerprintPromise;
}

function messageTextLength(message: VokerVoiceMessage): number {
  if (message.role === 'tool') return message.content.trim().length;
  return message.content.trim().length;
}

function countUsefulMessages(messages: VokerVoiceMessage[] | null | undefined): number {
  return (messages || []).filter((message) => {
    if (messageTextLength(message) > 0) return true;
    return message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  }).length;
}

function voiceTextLengths(input: BuildConectaVokerEventInput): {
  inputTextLength: number;
  outputTextLength: number;
  messageCount: number;
  usefulMessageCount: number;
  userTextLength: number;
  assistantTextLength: number;
} {
  const messages = input.vokerMessages || [];
  return {
    inputTextLength: String(input.inputText || '').trim().length,
    outputTextLength: String(input.outputText || '').trim().length,
    messageCount: messages.length,
    usefulMessageCount: countUsefulMessages(messages),
    userTextLength: messages
      .filter((message) => message.role === 'user')
      .reduce((total, message) => total + message.content.trim().length, 0),
    assistantTextLength: messages
      .filter((message) => message.role === 'assistant')
      .reduce((total, message) => total + message.content.trim().length, 0)
  };
}

function shouldSkipVoiceEventWithoutText(input: BuildConectaVokerEventInput): boolean {
  if (input.channel !== 'voice') return false;
  const lengths = voiceTextLengths(input);
  return lengths.inputTextLength === 0
    && lengths.outputTextLength === 0
    && lengths.usefulMessageCount === 0;
}

export async function sendConectaVokerEvent(input: BuildConectaVokerEventInput): Promise<void> {
  if (!isVokerObservabilityEnabled()) return;
  if (shouldSkipVoiceEventWithoutText(input)) {
    const lengths = voiceTextLengths(input);
    logWarn(LOG_CONTEXT, 'voker.observability.event_send_skipped', {
      reason: 'missing_voice_text_content',
      agentKey: input.agentKey,
      orgId: input.orgId || null,
      callId: input.callId || null,
      sessionId: input.sessionId || null,
      turnId: input.turnId || null,
      channel: input.channel,
      direction: input.direction,
      inputChars: lengths.inputTextLength,
      outputChars: lengths.outputTextLength,
      userChars: lengths.userTextLength,
      assistantChars: lengths.assistantTextLength,
      messageCount: lengths.messageCount,
      usefulMessageCount: lengths.usefulMessageCount
    });
    return;
  }
  const fingerprintId = await getFingerprintId();
  const payload = buildConectaVokerEventPayload(input, fingerprintId);
  const response = await vokerFetch('/api/v1/events', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    logWarn(LOG_CONTEXT, 'voker.observability.event_send_failed', {
      statusCode: response.status,
      agent: payload.agent,
      agentVersion: payload.agent_version,
      person: payload.person,
      session: payload.session,
      orgId: input.orgId || null,
      channel: input.channel,
      direction: input.direction
    });
    return;
  }
  logInfo(LOG_CONTEXT, 'voker.observability.event_send_succeeded', {
    statusCode: response.status,
    vokerEventId: body && typeof body === 'object' && 'id' in body ? String((body as { id?: string }).id || '') : null,
    agent: payload.agent,
    agentVersion: payload.agent_version,
    person: payload.person,
    session: payload.session,
    orgId: input.orgId || null,
    channel: input.channel,
    direction: input.direction
  });
}

export function emitConectaVokerEvent(input: BuildConectaVokerEventInput): void {
  void sendConectaVokerEvent(input).catch((error) => {
    logWarn(LOG_CONTEXT, 'voker.observability.event_send_error', {
      agentKey: input.agentKey,
      orgId: input.orgId || null,
      channel: input.channel,
      direction: input.direction,
      errorType: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  });
}

export function resetVokerObservabilityForTests(): void {
  fingerprintPromise = null;
  missingConfigWarningLogged = false;
}
