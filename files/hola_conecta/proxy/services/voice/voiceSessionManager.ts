import crypto from 'node:crypto';
import { logInfo, logWarn } from '../../utils/logger.js';
import { VoiceError } from './voiceErrors.ts';
import {
  createEmptySofiaReceptionistSessionState,
  createEmptySofiaSessionState
} from '../../sofia/voice/sofiaBookingState.ts';
import type { VoiceSession, VoiceSessionCreateInput, VoiceSessionStatus } from './voiceSessionTypes.ts';
import { initialVoiceLanguageFromConfig, voiceLiveLanguageCodeFromConfig } from './sofiaVoiceLanguage.ts';
import { phoneLogSummary } from './voiceLogSanitizer.ts';

const LOG_CONTEXT = 'voiceSessionManager';

const VALID_TRANSITIONS: Record<VoiceSessionStatus, VoiceSessionStatus[]> = {
  initializing: ['listening', 'closing', 'failed'],
  listening: ['thinking', 'speaking', 'closing', 'failed'],
  thinking: ['speaking', 'listening', 'closing', 'failed'],
  speaking: ['thinking', 'listening', 'closing', 'failed'],
  closing: ['closed', 'failed'],
  closed: [],
  failed: ['closing', 'closed']
};

export class VoiceSessionManager {
  private readonly sessions = new Map<string, VoiceSession>();

  create(input: VoiceSessionCreateInput): VoiceSession {
    const initialLanguage = input.initialLanguage || initialVoiceLanguageFromConfig();
    const initialLanguageCode = input.initialLanguageCode || voiceLiveLanguageCodeFromConfig();
    const languageSource = input.languageSource || 'system_instruction';
    const session: VoiceSession = {
      sessionId: crypto.randomUUID(),
      callId: input.callId,
      mediaCallId: input.mediaCallId || null,
      dialogId: input.dialogId,
      orgId: input.orgId,
      routeId: input.routeId || null,
      fromPhone: input.fromPhone,
      toPhone: input.toPhone,
      startedAt: Date.now(),
      lastAudioInAt: null,
      lastAudioOutAt: null,
      status: 'initializing',
      turnNumber: 0,
      wsReadyState: 0,
      correlationId: input.correlationId,
      sampleRateHertz: input.sampleRateHertz,
      frameBytes: Math.max(320, Math.round(input.sampleRateHertz * 0.02 * 2)),
      lastPongAt: Date.now(),
      inboundAudioBytes: 0,
      outboundAudioBytes: 0,
      languageState: {
        initialLanguageCode,
        currentLanguage: initialLanguage,
        responseLanguage: initialLanguage,
        previousLanguage: null,
        detectedLanguage: initialLanguage,
        requestedLanguage: null,
        languageLockedByCaller: false,
        languageLockReason: null,
        languageSwitchReason: input.initialLanguage
          ? 'initial_language_from_route_context'
          : 'initial_language_from_live_config',
        source: languageSource,
        updatedAt: new Date().toISOString()
      },
      ownerTestContext: null,
      sofiaState: createEmptySofiaSessionState({
        callerPhone: input.fromPhone
      }),
      sofiaReceptionist: createEmptySofiaReceptionistSessionState(),
      sofiaAdk: {
        toolBridgeDecisions: [],
        toolBridgeFailures: []
      }
    };

    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): VoiceSession | null {
    return this.sessions.get(sessionId) || null;
  }

  transition(session: VoiceSession, to: VoiceSessionStatus, reason: string): boolean {
    if (session.status === to) return true;
    const allowed = VALID_TRANSITIONS[session.status].includes(to);
    if (!allowed) {
      logWarn(LOG_CONTEXT, 'voice.state.invalid_transition', {
        sessionId: session.sessionId,
        callId: session.callId,
        ...phoneLogSummary(session.fromPhone, 'from'),
        ...phoneLogSummary(session.toPhone, 'to'),
        fromState: session.status,
        toState: to,
        reason,
        turnNumber: session.turnNumber
      });
      return false;
    }

    const fromState = session.status;
    session.status = to;
    logInfo(LOG_CONTEXT, 'voice.state.transition', {
      sessionId: session.sessionId,
      callId: session.callId,
      ...phoneLogSummary(session.fromPhone, 'from'),
      ...phoneLogSummary(session.toPhone, 'to'),
      fromState,
      toState: to,
      reason,
      turnNumber: session.turnNumber
    });
    return true;
  }

  requireTransition(session: VoiceSession, to: VoiceSessionStatus, reason: string): void {
    if (!this.transition(session, to, reason)) {
      throw new VoiceError('VOICE_INVALID_STATE_TRANSITION', `Invalid voice state transition from ${session.status} to ${to}`, 500);
    }
  }

  markAudioIn(session: VoiceSession, bytes: number, wsReadyState: number): void {
    session.lastAudioInAt = Date.now();
    session.wsReadyState = wsReadyState;
    session.inboundAudioBytes += bytes;
  }

  markAudioOut(session: VoiceSession, bytes: number, wsReadyState: number): void {
    session.lastAudioOutAt = Date.now();
    session.wsReadyState = wsReadyState;
    session.outboundAudioBytes += bytes;
  }

  remove(session: VoiceSession, reason: string): void {
    this.transition(session, session.status === 'closed' ? 'closed' : 'closing', reason);
    this.transition(session, 'closed', reason);
    this.sessions.delete(session.sessionId);
  }

  size(): number {
    return this.sessions.size;
  }
}

export const voiceSessionManager = new VoiceSessionManager();
