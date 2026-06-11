import { logInfo, logWarn } from '../../../utils/logger.js';
import { getOrgTimezoneForSofiaVoiceBooking } from '../../../models/sofiaVoiceBookingModel.ts';
import type { SofiaIdentityResolutionResult } from '../../../sofia/sofia_identity_agent/identityTypes.ts';
import { phoneLogSummary } from '../voiceLogSanitizer.ts';
import { buildTemporalContext } from '../infobipMediaWebSocketGemini.ts';
import {
  contactPreferredLanguageOverride,
  type SofiaVoiceResponseLanguage
} from '../sofiaVoiceLanguage.ts';
import {
  DEFAULT_CALLER_IDENTITY_SUMMARY,
  resolveInitialCallerIdentityContext
} from '../sofiaVoiceIdentityContext.ts';
import { resolveSofiaVoiceGreetingName } from '../sofiaVoiceGreetingName.ts';
import { buildSofiaVoiceDebugJsonDump } from '../sofiaVoiceDeepDebugLog.ts';
import {
  ownerTestContextInstruction,
  resolveOwnerTestOverride,
  SOFIA_OWNER_TEST_NAME_ENV,
  SOFIA_OWNER_TEST_PHONE_E164_ENV
} from '../sofiaOwnerTestOverride.ts';
import type { VoiceSession } from '../voiceSessionTypes.ts';

export type SessionStartupIdentityResult = {
  callerIdentity: SofiaIdentityResolutionResult | null;
  callerIdentitySummary: string;
};

export async function resolveStartupCallerIdentity(input: {
  currentTurnId: () => string | null;
  logContext: string;
  productionTraceMetadata: () => Record<string, unknown>;
  session: VoiceSession;
  updateSessionLanguage: (input: {
    detectedLanguage: SofiaVoiceResponseLanguage | null;
    requestedLanguage: SofiaVoiceResponseLanguage | null;
    switchReason: string;
    source: 'identity_override';
    confidence: number | null;
    transcriptPreview: string;
  }) => void;
}): Promise<SessionStartupIdentityResult> {
  const activeSession = input.session;
  logInfo(input.logContext, 'voice.context.identity_resolve.started', {
    sessionId: activeSession.sessionId,
    callId: activeSession.callId,
    orgId: activeSession.orgId
  });
  const identityContext = await resolveInitialCallerIdentityContext(activeSession, input.logContext);
  const callerIdentity = identityContext.callerIdentity;
  const contactLanguage = contactPreferredLanguageOverride({
    languageLockedByCaller: activeSession.languageState.languageLockedByCaller,
    preferredLanguage: callerIdentity?.preferredLanguage || null
  });
  if (contactLanguage) {
    input.updateSessionLanguage({
      detectedLanguage: contactLanguage,
      requestedLanguage: contactLanguage,
      switchReason: 'caller_contact_preferred_language',
      source: 'identity_override',
      confidence: 1,
      transcriptPreview: ''
    });
  }
  const callerIdentitySummary = [
    identityContext.callerIdentitySummary,
    activeSession.ownerTestContext ? ownerTestContextInstruction(activeSession.ownerTestContext) : ''
  ].filter(Boolean).join(' ') || DEFAULT_CALLER_IDENTITY_SUMMARY;
  logInfo(input.logContext, 'voice.context.identity_resolve.completed', {
    sessionId: activeSession.sessionId,
    callId: activeSession.callId,
    orgId: activeSession.orgId,
    identityDump: buildSofiaVoiceDebugJsonDump({
      label: 'initial_caller_identity_context',
      value: identityContext
    })
  });
  return {
    callerIdentity,
    callerIdentitySummary
  };
}

export function applyStartupOwnerTestOverride(input: {
  currentTurnId: () => string | null;
  logContext: string;
  productionTraceMetadata: () => Record<string, unknown>;
  session: VoiceSession;
}): void {
  const activeSession = input.session;
  const override = resolveOwnerTestOverride(activeSession.fromPhone);
  if (!override) {
    logInfo(input.logContext, 'voice.identity.owner_test_override.not_matched', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      turnId: input.currentTurnId(),
      ...phoneLogSummary(activeSession.fromPhone, 'from'),
      configured: Boolean(String(process.env[SOFIA_OWNER_TEST_PHONE_E164_ENV] || '').trim()),
      source: SOFIA_OWNER_TEST_PHONE_E164_ENV
    });
    return;
  }

  activeSession.ownerTestContext = override;
  logInfo(input.logContext, 'voice.identity.owner_test_override.matched', {
    ...input.productionTraceMetadata(),
    sessionId: activeSession.sessionId,
    callId: activeSession.callId,
    turnId: input.currentTurnId(),
    ...phoneLogSummary(activeSession.fromPhone, 'from'),
    ownerName: override.name,
    ownerRole: override.role,
    phoneEnv: SOFIA_OWNER_TEST_PHONE_E164_ENV,
    nameEnv: SOFIA_OWNER_TEST_NAME_ENV
  });
  logInfo(input.logContext, 'voice.context.owner_test_context_applied', {
    ...input.productionTraceMetadata(),
    sessionId: activeSession.sessionId,
    callId: activeSession.callId,
    turnId: input.currentTurnId(),
    ...phoneLogSummary(activeSession.fromPhone, 'from'),
    ownerContextDump: buildSofiaVoiceDebugJsonDump({
      label: 'sofia_owner_test_context',
      value: {
        ownerName: override.name,
        ownerRole: override.role,
        contextInstruction: ownerTestContextInstruction(override)
      }
    })
  });
}

export async function resolveStartupGreetingBusinessName(input: {
  logContext: string;
  orgId: string;
  session: VoiceSession | null;
}): Promise<string> {
  try {
    const resolved = await resolveSofiaVoiceGreetingName(input.orgId);
    logInfo(input.logContext, 'voice.greeting.business_name.resolved', {
      sessionId: input.session?.sessionId || null,
      callId: input.session?.callId || null,
      orgId: input.orgId,
      greetingBusinessName: resolved
    });
    return resolved;
  } catch (error) {
    logWarn(input.logContext, 'voice.greeting.business_name.resolve_failed', {
      sessionId: input.session?.sessionId || null,
      callId: input.session?.callId || null,
      orgId: input.orgId,
      fallbackGreetingBusinessName: 'this business',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return 'this business';
  }
}

export async function resolveStartupTemporalContext(input: {
  logContext: string;
  session: VoiceSession;
}): Promise<string> {
  try {
    const temporalContext = buildTemporalContext(await getOrgTimezoneForSofiaVoiceBooking(input.session.orgId));
    logInfo(input.logContext, 'voice.context.temporal.selected', {
      sessionId: input.session.sessionId,
      callId: input.session.callId,
      orgId: input.session.orgId,
      temporalContextDump: buildSofiaVoiceDebugJsonDump({
        label: 'sofia_temporal_context',
        value: { temporalContext }
      })
    });
    return temporalContext;
  } catch (error) {
    logWarn(input.logContext, 'voice.gemini.temporal_context_timezone_failed', {
      sessionId: input.session.sessionId,
      callId: input.session.callId,
      orgId: input.session.orgId,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    const temporalContext = buildTemporalContext(null);
    logInfo(input.logContext, 'voice.context.temporal.selected', {
      sessionId: input.session.sessionId,
      callId: input.session.callId,
      orgId: input.session.orgId,
      temporalContextDump: buildSofiaVoiceDebugJsonDump({
        label: 'sofia_temporal_context_fallback',
        value: { temporalContext }
      })
    });
    return temporalContext;
  }
}

