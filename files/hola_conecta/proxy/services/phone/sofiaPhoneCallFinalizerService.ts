import { logError, logInfo } from '../../utils/logger.js';
import {
  createFinalizationReview,
  insertInboxPhoneMessage,
  insertUsageLedger,
  touchLinkedActivity,
  upsertPhoneCallSession,
  type PhoneCallOutcome,
  type PhoneCallSessionRow
} from '../../models/phoneCallModel.ts';
import type { SofiaIdentityResolutionResult } from '../../sofia/sofia_identity_agent/identityTypes.ts';
import type {
  SofiaReceptionistCallSummary,
  SofiaReceptionistOutcomeType,
  VoiceSession
} from '../voice/voiceSessionTypes.ts';
import { closePhoneLiveState } from './phoneLiveStateService.ts';
import { recordPhoneCallTimeline } from './phoneCallTimelineService.ts';
import {
  logPhoneJsonHandoff,
  phoneJsonHandoffIdsFromSession,
  type PhoneJsonHandoffIds
} from './phoneJsonHandoffLogger.ts';
import { phoneLogSummary } from '../voice/voiceLogSanitizer.ts';
import { runSophiaAdkPostCallDecision, type SophiaAdkDecisionOutput } from '../../sofia/adk/index.ts';

type FinalizationFailure = {
  step: string;
  error: string;
  at: string;
};

type StepResult = {
  step: string;
  ok: boolean;
  id?: string | null;
};

const LOG_CONTEXT = 'sofiaPhoneCallFinalizerService';

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function uniqueOutcomes(outcomes: SofiaReceptionistOutcomeType[]): SofiaReceptionistOutcomeType[] {
  return [...new Set(outcomes)];
}

function mapOutcome(input: {
  session: VoiceSession;
  summary: SofiaReceptionistCallSummary;
  closeReason: string;
}): PhoneCallOutcome {
  const outcomes = new Set(input.summary.outcomes);
  if (input.session.ownerTestContext?.matched) return 'test_call';
  if (outcomes.has('booking_created')) return 'appointment_booked';
  if (outcomes.has('callback_task_created') || input.summary.escalationReasons.includes('callback_request')) return 'callback_requested';
  if (outcomes.has('message_taken')) return 'message_taken';
  if (input.summary.escalationRequired || outcomes.has('human_escalation_needed')) return 'human_handoff_needed';
  if (/error|failed|1011|1013/i.test(input.closeReason) || outcomes.has('tool_failure')) return 'failed_call';
  if (/caller|hang|stop|closed|normal|final_audio|end_call/i.test(input.closeReason)) return 'caller_hung_up';
  if (outcomes.has('document_status_checked') || outcomes.has('signature_status_checked') || outcomes.has('booking_lookup_completed') || outcomes.has('no_action_needed')) return 'answered_question';
  return 'system_error';
}

function readableOutcome(outcome: PhoneCallOutcome): string {
  return outcome.replace(/_/g, ' ');
}

function buildInboxBody(input: {
  session: VoiceSession;
  summary: SofiaReceptionistCallSummary;
  outcome: PhoneCallOutcome;
}): string {
  const lines = [
    `Sofia phone call outcome: ${readableOutcome(input.outcome)}`,
    `Summary: ${input.summary.nextRecommendedStaffAction}`,
    `Language: ${input.summary.language || 'unknown'}`,
    `Requested topic: ${input.summary.requestedTopic || 'unknown'}`,
    `Contact: ${input.summary.matchedContactDisplayName || input.summary.matchedContactId || 'not matched'}`,
    `Call ID: ${input.session.callId}`,
    `Session ID: ${input.session.sessionId}`
  ];

  if (input.summary.followUpTaskId) lines.push(`Callback/follow-up task ID: ${input.summary.followUpTaskId}`);
  if (input.session.sofiaState.booking.bookingId) lines.push(`Booking ID: ${input.session.sofiaState.booking.bookingId}`);
  if (input.summary.unresolvedIssues.length) lines.push(`Unresolved: ${input.summary.unresolvedIssues.join('; ')}`);
  return lines.join('\n');
}

function startedAt(session: VoiceSession): string {
  return new Date(session.startedAt).toISOString();
}

function durationSeconds(session: VoiceSession, endedAt: string): number {
  return Math.max(0, Math.round((new Date(endedAt).getTime() - session.startedAt) / 1000));
}

function safeMetadata(input: {
  session: VoiceSession;
  summary: SofiaReceptionistCallSummary;
  identity: SofiaIdentityResolutionResult | null;
  outcome: PhoneCallOutcome;
  closeReason: string;
  adkDecision: SophiaAdkDecisionOutput | null;
}): Record<string, unknown> {
  return {
    source: 'sofia_phone_call_finalizer',
    closeReason: input.closeReason,
    outcome: input.outcome,
    sophiaAdk: input.adkDecision ? {
      orchestrationVersion: input.adkDecision.orchestrationVersion,
      action: input.adkDecision.action,
      intents: input.adkDecision.intents,
      safety: input.adkDecision.safety,
      handoff: input.adkDecision.handoff,
      toolPlan: input.adkDecision.toolPlan,
      staffSummary: input.adkDecision.staffSummary,
      trace: input.adkDecision.trace,
      usedAdkAgents: input.adkDecision.usedAdkAgents,
      liveToolBridge: {
        decisions: input.session.sofiaAdk.toolBridgeDecisions.slice(-50),
        failures: input.session.sofiaAdk.toolBridgeFailures.slice(-50),
        decisionCount: input.session.sofiaAdk.toolBridgeDecisions.length,
        failureCount: input.session.sofiaAdk.toolBridgeFailures.length
      }
    } : null,
    receptionistOutcomes: uniqueOutcomes(input.summary.outcomes),
    escalationRequired: input.summary.escalationRequired,
    escalationReasons: input.summary.escalationReasons,
    unresolvedIssues: input.summary.unresolvedIssues,
    identityStatus: input.identity?.identityStatus || null,
    trustLevel: input.identity?.trustLevel || null,
    ownerTestContextMatched: input.session.ownerTestContext?.matched === true,
    actionsAttempted: input.summary.actionsAttempted.slice(-30),
    audio: {
      inboundAudioBytes: input.session.inboundAudioBytes,
      outboundAudioBytes: input.session.outboundAudioBytes,
      sampleRateHertz: input.session.sampleRateHertz
    }
  };
}

async function runStep<T>(
  step: string,
  failures: FinalizationFailure[],
  results: StepResult[],
  fn: () => Promise<T>,
  idFromResult: (result: T) => string | null = () => null,
  onFailure?: (failure: FinalizationFailure) => void
): Promise<T | null> {
  try {
    const result = await fn();
    results.push({ step, ok: true, id: idFromResult(result) });
    return result;
  } catch (error) {
    const failure = {
      step,
      error: errorMessage(error),
      at: new Date().toISOString()
    };
    failures.push(failure);
    results.push({ step, ok: false });
    logError(LOG_CONTEXT, 'phone.finalization.step_failed', error, { step });
    onFailure?.(failure);
    return null;
  }
}

export async function finalizeSofiaPhoneCall(input: {
  session: VoiceSession;
  identity: SofiaIdentityResolutionResult | null;
  summary: SofiaReceptionistCallSummary;
  closeReason: string;
}): Promise<PhoneCallSessionRow | null> {
  const endedAt = new Date().toISOString();
  const outcome = mapOutcome(input);
  let adkDecision: SophiaAdkDecisionOutput | null = null;
  try {
    adkDecision = runSophiaAdkPostCallDecision({
      orgId: input.session.orgId,
      closeReason: input.closeReason,
      summary: input.summary,
      identity: {
        identityStatus: input.identity?.identityStatus || null,
        trustLevel: input.identity?.trustLevel || null,
        verifiedFactors: input.identity?.verifiedFactors || []
      }
    });
    logInfo(LOG_CONTEXT, 'phone.finalization.sophia_adk_decision_created', {
      orgId: input.session.orgId,
      callId: input.session.callId,
      sessionId: input.session.sessionId,
      orchestrationVersion: adkDecision.orchestrationVersion,
      action: adkDecision.action,
      intents: adkDecision.intents,
      handoffNeeded: adkDecision.handoff.needed,
      traceLength: adkDecision.trace.length,
      liveToolBridgeDecisionCount: input.session.sofiaAdk.toolBridgeDecisions.length,
      liveToolBridgeFailureCount: input.session.sofiaAdk.toolBridgeFailures.length
    });
  } catch (error) {
    logError(LOG_CONTEXT, 'phone.finalization.sophia_adk_decision_failed', error, {
      orgId: input.session.orgId,
      callId: input.session.callId,
      sessionId: input.session.sessionId
    });
  }
  const failures: FinalizationFailure[] = [];
  const stepResults: StepResult[] = [];
  const contactId = input.summary.matchedContactId;
  const businessId = null;
  const bookingId = input.session.sofiaState.booking.bookingId || input.session.sofiaState.booking.activeBookingId || null;
  let phoneCallSession: PhoneCallSessionRow | null = null;
  let inboxMessageId: string | null = null;
  const metadata = safeMetadata({
    session: input.session,
    summary: input.summary,
    identity: input.identity,
    outcome,
    closeReason: input.closeReason,
    adkDecision
  });
  const baseIds = (): PhoneJsonHandoffIds => phoneJsonHandoffIdsFromSession(input.session, phoneCallSession?.id || null);

  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.input_received',
    sender: 'sofia_voice_runtime',
    converter: 'sofia_phone_call_finalizer',
    receiver: 'phone_finalizer_pipeline',
    direction: 'sender_to_converter',
    stage: 'phone_finalizer_input_received',
    status: 'received',
    ids: baseIds(),
    json: {
      orgId: input.session.orgId,
      providerCallId: input.session.callId,
      runtimeSessionId: input.session.sessionId,
      closeReason: input.closeReason,
      outcome,
      language: input.summary.language || null,
      contactLinked: Boolean(contactId),
      businessLinked: Boolean(businessId),
      callbackTaskLinked: Boolean(input.summary.followUpTaskId),
      bookingLinked: Boolean(bookingId),
      escalationRequired: input.summary.escalationRequired,
      summaryPresent: Boolean(input.summary.nextRecommendedStaffAction),
      sophiaAdkPostCallDecisionPresent: Boolean(adkDecision),
      sophiaAdkLiveToolBridgeDecisionCount: input.session.sofiaAdk.toolBridgeDecisions.length,
      sophiaAdkLiveToolBridgeFailureCount: input.session.sofiaAdk.toolBridgeFailures.length,
      ...phoneLogSummary(input.session.fromPhone, 'from'),
      ...phoneLogSummary(input.session.toPhone, 'to')
    }
  });

  const initialSessionUpsertJson = {
    orgId: input.session.orgId,
    providerCallId: input.session.callId,
    runtimeSessionId: input.session.sessionId,
    providerDialogIdPresent: Boolean(input.session.dialogId),
    contactLinked: Boolean(contactId),
    businessLinked: Boolean(businessId),
    inboxMessageLinked: false,
    callbackTaskLinked: Boolean(input.summary.followUpTaskId),
    bookingLinked: Boolean(bookingId),
    outcome,
    finalizationStatus: 'pending',
    language: input.summary.language || null,
    summaryPresent: Boolean(input.summary.nextRecommendedStaffAction),
    startedAt: startedAt(input.session),
    endedAt,
    durationSeconds: durationSeconds(input.session, endedAt),
    turnCount: input.session.turnNumber,
    closeReason: input.closeReason,
    correlationId: input.session.correlationId,
    metadataKeys: Object.keys(metadata).sort(),
    sophiaAdkPostCallDecisionPresent: Boolean(adkDecision),
    sophiaAdkLiveToolBridgeDecisionCount: input.session.sofiaAdk.toolBridgeDecisions.length,
    sophiaAdkLiveToolBridgeFailureCount: input.session.sofiaAdk.toolBridgeFailures.length,
    ...phoneLogSummary(input.session.fromPhone, 'from'),
    ...phoneLogSummary(input.session.toPhone, 'to')
  };
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.session_upsert',
    sender: 'sofia_voice_runtime',
    converter: 'sofia_phone_call_finalizer',
    receiver: 'phone_call_sessions',
    direction: 'converter_to_receiver',
    stage: 'call_session_initial_upsert_started',
    status: 'started',
    ids: baseIds(),
    json: initialSessionUpsertJson
  });
  phoneCallSession = await runStep('upsert_call_session_initial', failures, stepResults, () => upsertPhoneCallSession({
    orgId: input.session.orgId,
    providerCallId: input.session.callId,
    providerDialogId: input.session.dialogId,
    voiceSessionId: input.session.sessionId,
    fromPhone: input.session.fromPhone || null,
    toPhone: input.session.toPhone || null,
    contactId,
    businessId,
    inboxMessageId: null,
    callbackTaskId: input.summary.followUpTaskId,
    bookingId,
    outcome,
    status: outcome === 'failed_call' || outcome === 'system_error' ? 'failed' : 'finalized',
    finalizationStatus: 'pending',
    language: input.summary.language,
    summary: input.summary.nextRecommendedStaffAction,
    startedAt: startedAt(input.session),
    endedAt,
    durationSeconds: durationSeconds(input.session, endedAt),
    inboundAudioBytes: input.session.inboundAudioBytes,
    outboundAudioBytes: input.session.outboundAudioBytes,
    turnCount: input.session.turnNumber,
    closeReason: input.closeReason,
    correlationId: input.session.correlationId,
    metadata,
    finalizationErrors: []
  }), (result) => result.id, (failure) => {
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.session_upsert',
      sender: 'phone_call_sessions',
      converter: 'sofia_phone_call_finalizer',
      receiver: 'phone_finalization_failure_tracker',
      direction: 'receiver_failed',
      stage: 'call_session_initial_upsert_failed',
      status: 'failed',
      ids: baseIds(),
      json: {
        ...initialSessionUpsertJson,
        errorPresent: Boolean(failure.error)
      },
      reason: failure.error
    });
  });

  if (!phoneCallSession) {
    const reviewId = await runStep('create_finalization_review_without_session', failures, stepResults, () => createFinalizationReview({
      orgId: input.session.orgId,
      phoneCallSessionId: null,
      providerCallId: input.session.callId,
      voiceSessionId: input.session.sessionId,
      severity: 'critical',
      reason: 'Sofia phone call finalization could not create the durable call session.',
      failedSteps: failures,
      metadata: {
        providerCallId: input.session.callId,
        voiceSessionId: input.session.sessionId,
        outcome,
        finalizationStepResults: stepResults
      }
    }), (result) => result);
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.review_created',
      sender: 'sofia_phone_call_finalizer',
      converter: 'finalization_review_adapter',
      receiver: 'phone_call_finalization_reviews',
      direction: 'converter_to_receiver',
      stage: 'critical_review_created_without_call_session',
      status: reviewId ? 'completed' : 'failed',
      ids: baseIds(),
      json: {
        reviewCreated: Boolean(reviewId),
        reviewId: reviewId || null,
        severity: 'critical',
        failedStepCount: failures.length
      },
      reason: reviewId ? null : 'review_write_failed'
    });
    logError(LOG_CONTEXT, 'phone.finalization.no_call_session', null, {
      orgId: input.session.orgId,
      callId: input.session.callId,
      reviewId,
      failures
    });
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.failed',
      sender: 'sofia_phone_call_finalizer',
      converter: 'phone_finalization_failure_tracker',
      receiver: 'operator_review',
      direction: 'converter_to_receiver',
      stage: 'phone_finalizer_failed_without_call_session',
      status: 'failed',
      ids: baseIds(),
      json: {
        callSessionSaved: false,
        reviewCreated: Boolean(reviewId),
        failedStepCount: failures.length
      },
      reason: 'phone_call_session_not_saved'
    });
    return null;
  }
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.session_upsert',
    sender: 'phone_call_sessions',
    converter: 'sofia_phone_call_finalizer',
    receiver: 'phone_finalizer_pipeline',
    direction: 'receiver_response',
    stage: 'call_session_initial_upsert_completed',
    status: 'completed',
    ids: baseIds(),
    json: {
      callSessionId: phoneCallSession.id,
      providerCallId: phoneCallSession.provider_call_id,
      finalizationStatus: phoneCallSession.finalization_status,
      outcome: phoneCallSession.outcome,
      contactLinked: Boolean(phoneCallSession.contact_id),
      businessLinked: Boolean(phoneCallSession.business_id)
    }
  });

  await runStep('close_live_state', failures, stepResults, () => closePhoneLiveState({
    session: input.session,
    outcome,
    closeReason: input.closeReason,
    endedAt,
    phoneCallSession
  }), (result) => result.path, (failure) => {
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.failed',
      sender: 'phone_live_state_service',
      converter: 'sofia_phone_call_finalizer',
      receiver: 'phone_finalization_failure_tracker',
      direction: 'receiver_failed',
      stage: 'live_state_close_failed',
      status: 'failed',
      ids: baseIds(),
      json: {
        step: failure.step,
        errorPresent: Boolean(failure.error),
        at: failure.at
      },
      reason: failure.error
    });
  });

  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.timeline_event',
    sender: 'sofia_phone_call_finalizer',
    converter: 'phone_call_timeline_service',
    receiver: 'phone_call_events',
    direction: 'converter_to_receiver',
    stage: 'timeline_event_append_started',
    status: 'started',
    ids: baseIds(),
    json: {
      callSessionId: phoneCallSession.id,
      eventType: 'call_finalized',
      contactLinked: Boolean(contactId)
    }
  });
  const finalizedEvent = await runStep('append_finalized_event', failures, stepResults, () => recordPhoneCallTimeline({
    orgId: input.session.orgId,
    phoneCallSessionId: phoneCallSession.id,
    providerCallId: input.session.callId,
    runtimeSessionId: input.session.sessionId,
    traceId: baseIds().traceId || null,
    contactId,
    eventType: 'call_finalized',
    eventSummary: `Sofia call finalized: ${readableOutcome(outcome)}`,
    metadata,
    occurredAt: endedAt
  }), (result) => result.phoneCallEventId, (failure) => {
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.timeline_event',
      sender: 'phone_call_timeline_service',
      converter: 'sofia_phone_call_finalizer',
      receiver: 'phone_finalization_failure_tracker',
      direction: 'receiver_failed',
      stage: 'timeline_event_write_failed',
      status: 'failed',
      ids: baseIds(),
      json: {
        step: failure.step,
        eventType: 'call_finalized',
        contactLinked: Boolean(contactId),
        errorPresent: Boolean(failure.error)
      },
      reason: failure.error
    });
  });
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.timeline_event',
    sender: 'phone_call_events',
    converter: 'phone_call_timeline_service',
    receiver: 'sofia_phone_call_finalizer',
    direction: 'receiver_response',
    stage: 'timeline_event_append_completed',
    status: finalizedEvent ? 'completed' : 'failed',
    ids: baseIds(),
    json: {
      callSessionId: phoneCallSession.id,
      eventType: 'call_finalized',
      phoneCallEventId: finalizedEvent?.phoneCallEventId || null
    },
    reason: finalizedEvent ? null : 'phone_call_event_not_saved'
  });

  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.inbox_create',
    sender: 'sofia_phone_call_finalizer',
    converter: 'inbox_message_adapter',
    receiver: 'unified_inbox',
    direction: 'converter_to_receiver',
    stage: 'inbox_phone_item_create_started',
    status: 'started',
    ids: baseIds(),
    json: {
      orgId: input.session.orgId,
      callSessionId: phoneCallSession.id,
      contactLinked: Boolean(contactId),
      businessLinked: Boolean(businessId),
      subjectPresent: true,
      bodyPresent: true,
      outcome,
      bookingLinked: Boolean(bookingId),
      callbackTaskLinked: Boolean(input.summary.followUpTaskId),
      ...phoneLogSummary(input.session.fromPhone, 'from'),
      ...phoneLogSummary(input.session.toPhone, 'to')
    }
  });
  const inbox = await runStep('create_inbox_phone_item', failures, stepResults, () => insertInboxPhoneMessage({
    orgId: input.session.orgId,
    contactId,
    businessId,
    fromPhone: input.session.fromPhone || null,
    toPhone: input.session.toPhone || null,
    providerCallId: input.session.callId,
    subject: `Sofia phone call: ${readableOutcome(outcome)}`,
    body: buildInboxBody({ session: input.session, summary: input.summary, outcome }),
    metadata: {
      ...metadata,
      phoneCallSessionId: phoneCallSession?.id || null,
      bookingId,
      callbackTaskId: input.summary.followUpTaskId
    }
  }), (result) => result, (failure) => {
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.inbox_create',
      sender: 'unified_inbox',
      converter: 'inbox_message_adapter',
      receiver: 'phone_finalization_failure_tracker',
      direction: 'receiver_failed',
      stage: 'inbox_phone_item_create_failed',
      status: 'failed',
      ids: baseIds(),
      json: {
        step: failure.step,
        errorPresent: Boolean(failure.error),
        contactLinked: Boolean(contactId),
        businessLinked: Boolean(businessId)
      },
      reason: failure.error
    });
  });
  inboxMessageId = inbox;
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.inbox_create',
    sender: 'unified_inbox',
    converter: 'inbox_message_adapter',
    receiver: 'sofia_phone_call_finalizer',
    direction: 'receiver_response',
    stage: 'inbox_phone_item_create_completed',
    status: inboxMessageId ? 'completed' : 'failed',
    ids: baseIds(),
    json: {
      inboxMessageCreated: Boolean(inboxMessageId),
      inboxMessageId: inboxMessageId || null
    },
    reason: inboxMessageId ? null : 'inbox_message_not_saved'
  });

  if (contactId || businessId) {
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.contact_activity_link',
      sender: 'sofia_phone_call_finalizer',
      converter: 'contact_business_activity_adapter',
      receiver: 'contact_business_activity',
      direction: 'converter_to_receiver',
      stage: 'contact_activity_link_started',
      status: 'started',
      ids: baseIds(),
      json: {
        contactLinked: Boolean(contactId),
        businessLinked: Boolean(businessId),
        occurredAt: endedAt
      }
    });
    await runStep('link_contact_business_activity', failures, stepResults, () => touchLinkedActivity({
      orgId: input.session.orgId,
      contactId,
      businessId,
      occurredAt: endedAt
    }), () => null, (failure) => {
      logPhoneJsonHandoff({
        event: 'voice.json.phone_finalizer.contact_activity_link',
        sender: 'contact_business_activity',
        converter: 'contact_business_activity_adapter',
        receiver: 'phone_finalization_failure_tracker',
        direction: 'receiver_failed',
        stage: 'contact_activity_link_failed',
        status: 'failed',
        ids: baseIds(),
        json: {
          step: failure.step,
          errorPresent: Boolean(failure.error),
          contactLinked: Boolean(contactId),
          businessLinked: Boolean(businessId)
        },
        reason: failure.error
      });
    });
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.contact_activity_link',
      sender: 'contact_business_activity',
      converter: 'contact_business_activity_adapter',
      receiver: 'sofia_phone_call_finalizer',
      direction: 'receiver_response',
      stage: 'contact_activity_link_completed',
      status: failures.some((failure) => failure.step === 'link_contact_business_activity') ? 'failed' : 'completed',
      ids: baseIds(),
      json: {
        contactLinked: Boolean(contactId),
        businessLinked: Boolean(businessId)
      }
    });
  }

  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.usage_ledger_write',
    sender: 'sofia_phone_call_finalizer',
    converter: 'usage_ledger_adapter',
    receiver: 'phone_usage_ledger',
    direction: 'converter_to_receiver',
    stage: 'usage_ledger_write_started',
    status: 'started',
    ids: baseIds(),
    json: {
      callSessionId: phoneCallSession.id,
      usageType: 'voice_call',
      quantityUnit: 'second',
      quantity: durationSeconds(input.session, endedAt),
      billable: false
    }
  });
  const usageLedgerId = await runStep('write_usage_ledger', failures, stepResults, () => insertUsageLedger({
    orgId: input.session.orgId,
    phoneCallSessionId: phoneCallSession.id,
    quantity: durationSeconds(input.session, endedAt),
    quantityUnit: 'second',
    billable: false,
    metadata: {
      source: 'sofia_phone_call_finalizer',
      providerCallId: input.session.callId,
      voiceSessionId: input.session.sessionId
    },
    occurredAt: endedAt
  }), (result) => result, (failure) => {
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.usage_ledger_write',
      sender: 'phone_usage_ledger',
      converter: 'usage_ledger_adapter',
      receiver: 'phone_finalization_failure_tracker',
      direction: 'receiver_failed',
      stage: 'usage_ledger_write_failed',
      status: 'failed',
      ids: baseIds(),
      json: {
        step: failure.step,
        errorPresent: Boolean(failure.error)
      },
      reason: failure.error
    });
  });
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.usage_ledger_write',
    sender: 'phone_usage_ledger',
    converter: 'usage_ledger_adapter',
    receiver: 'sofia_phone_call_finalizer',
    direction: 'receiver_response',
    stage: 'usage_ledger_write_completed',
    status: usageLedgerId ? 'completed' : 'failed',
    ids: baseIds(),
    json: {
      usageLedgerWritten: Boolean(usageLedgerId),
      usageLedgerId: usageLedgerId || null
    },
    reason: usageLedgerId ? null : 'usage_ledger_not_saved'
  });

  const finalStatus = failures.length === 0 ? 'complete' : 'partial_failed';
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.session_upsert',
    sender: 'sofia_phone_call_finalizer',
    converter: 'sofia_phone_call_finalizer',
    receiver: 'phone_call_sessions',
    direction: 'converter_to_receiver',
    stage: 'call_session_final_upsert_started',
    status: 'started',
    ids: baseIds(),
    json: {
      callSessionId: phoneCallSession.id,
      inboxMessageLinked: Boolean(inboxMessageId),
      callbackTaskLinked: Boolean(input.summary.followUpTaskId),
      bookingLinked: Boolean(bookingId),
      finalizationStatus: finalStatus,
      finalizationErrorCount: failures.length
    }
  });
  const finalSession = await runStep('upsert_call_session_final', failures, stepResults, () => upsertPhoneCallSession({
    orgId: input.session.orgId,
    providerCallId: input.session.callId,
    providerDialogId: input.session.dialogId,
    voiceSessionId: input.session.sessionId,
    fromPhone: input.session.fromPhone || null,
    toPhone: input.session.toPhone || null,
    contactId,
    businessId,
    inboxMessageId,
    callbackTaskId: input.summary.followUpTaskId,
    bookingId,
    outcome,
    status: outcome === 'failed_call' || outcome === 'system_error' ? 'failed' : 'finalized',
    finalizationStatus: finalStatus,
    language: input.summary.language,
    summary: input.summary.nextRecommendedStaffAction,
    startedAt: startedAt(input.session),
    endedAt,
    durationSeconds: durationSeconds(input.session, endedAt),
    inboundAudioBytes: input.session.inboundAudioBytes,
    outboundAudioBytes: input.session.outboundAudioBytes,
    turnCount: input.session.turnNumber,
    closeReason: input.closeReason,
    correlationId: input.session.correlationId,
    metadata: {
      ...metadata,
      finalizationStepResults: stepResults
    },
    finalizationErrors: failures
  }), (result) => result.id, (failure) => {
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.session_upsert',
      sender: 'phone_call_sessions',
      converter: 'sofia_phone_call_finalizer',
      receiver: 'phone_finalization_failure_tracker',
      direction: 'receiver_failed',
      stage: 'call_session_final_upsert_failed',
      status: 'failed',
      ids: baseIds(),
      json: {
        step: failure.step,
        errorPresent: Boolean(failure.error),
        finalizationStatus: finalStatus
      },
      reason: failure.error
    });
  });
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.session_upsert',
    sender: 'phone_call_sessions',
    converter: 'sofia_phone_call_finalizer',
    receiver: 'phone_finalizer_pipeline',
    direction: 'receiver_response',
    stage: 'call_session_final_upsert_completed',
    status: finalSession ? 'completed' : 'failed',
    ids: baseIds(),
    json: {
      callSessionSaved: Boolean(finalSession),
      callSessionId: finalSession?.id || phoneCallSession.id,
      finalizationStatus: finalSession?.finalization_status || finalStatus,
      inboxMessageLinked: Boolean(finalSession?.inbox_message_id || inboxMessageId),
      callbackTaskLinked: Boolean(finalSession?.callback_task_id || input.summary.followUpTaskId),
      bookingLinked: Boolean(finalSession?.booking_id || bookingId)
    },
    reason: finalSession ? null : 'final_call_session_upsert_not_saved'
  });

  if (failures.length > 0) {
    const reviewId = await runStep('create_finalization_review', failures, stepResults, () => createFinalizationReview({
      orgId: input.session.orgId,
      phoneCallSessionId: phoneCallSession?.id || null,
      providerCallId: input.session.callId,
      voiceSessionId: input.session.sessionId,
      severity: failures.some((failure) => failure.step === 'upsert_call_session_initial') ? 'critical' : 'error',
      reason: 'Sofia phone call finalization partially failed.',
      failedSteps: failures,
      metadata: {
        providerCallId: input.session.callId,
        voiceSessionId: input.session.sessionId,
        outcome,
        finalizationStepResults: stepResults
      }
    }), (result) => result);
    logPhoneJsonHandoff({
      event: 'voice.json.phone_finalizer.review_created',
      sender: 'sofia_phone_call_finalizer',
      converter: 'finalization_review_adapter',
      receiver: 'phone_call_finalization_reviews',
      direction: 'converter_to_receiver',
      stage: 'partial_failure_review_created',
      status: reviewId ? 'completed' : 'failed',
      ids: baseIds(),
      json: {
        reviewCreated: Boolean(reviewId),
        reviewId: reviewId || null,
        failedStepCount: failures.length,
        finalizationStatus: finalStatus
      },
      reason: reviewId ? null : 'review_write_failed'
    });
  }

  logInfo(LOG_CONTEXT, 'phone.finalization.completed', {
    orgId: input.session.orgId,
    callId: input.session.callId,
    sessionId: input.session.sessionId,
    phoneCallSessionId: finalSession?.id || phoneCallSession.id,
    outcome,
    finalizationStatus: finalStatus,
    inboxMessageCreated: Boolean(inboxMessageId),
    callbackTaskLinked: Boolean(input.summary.followUpTaskId),
    bookingLinked: Boolean(bookingId),
    failureCount: failures.length
  });

  logPhoneJsonHandoff({
    event: failures.length === 0
      ? 'voice.json.phone_finalizer.completed'
      : 'voice.json.phone_finalizer.failed',
    sender: 'sofia_phone_call_finalizer',
    converter: 'phone_finalization_status_adapter',
    receiver: failures.length === 0 ? 'phone_finalizer_pipeline' : 'operator_review',
    direction: 'converter_to_receiver',
    stage: failures.length === 0 ? 'phone_finalizer_completed' : 'phone_finalizer_partial_failed',
    status: failures.length === 0 ? 'completed' : 'failed',
    ids: baseIds(),
    json: {
      callSessionId: finalSession?.id || phoneCallSession.id,
      outcome,
      finalizationStatus: finalStatus,
      inboxMessageCreated: Boolean(inboxMessageId),
      callbackTaskLinked: Boolean(input.summary.followUpTaskId),
      bookingLinked: Boolean(bookingId),
      failureCount: failures.length
    },
    reason: failures.length === 0 ? null : 'one_or_more_phone_finalization_steps_failed'
  });

  return finalSession || phoneCallSession;
}
