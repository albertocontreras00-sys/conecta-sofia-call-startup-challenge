import type { SofiaReceptionistEscalationReason, SofiaReceptionistOutcomeType } from '../../services/voice/voiceSessionTypes.ts';
import { findSophiaAdkTool } from './tools.ts';
import './agents.ts';
import type {
  SophiaAdkAgentName,
  SophiaAdkDecisionAction,
  SophiaAdkDecisionInput,
  SophiaAdkDecisionOutput,
  SophiaAdkIntent,
  SophiaAdkPostCallInput,
  SophiaAdkSafetyDecision,
  SophiaAdkToolName,
  SophiaAdkToolPlanStep,
  SophiaAdkTraceEntry
} from './types.ts';

const ORCHESTRATION_VERSION = 'sophia_adk_phase_1' as const;

function normalizedText(input: SophiaAdkDecisionInput): string {
  return [
    input.message,
    input.summary?.requestedTopic || '',
    input.summary?.nextRecommendedStaffAction || '',
    ...(input.summary?.unresolvedIssues || []),
    ...(input.summary?.escalationReasons || []),
    ...(input.summary?.outcomes || [])
  ].join(' ').toLowerCase();
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function trace(
  agent: SophiaAdkAgentName,
  decision: string,
  inputs: SophiaAdkTraceEntry['inputs'],
  outputs: SophiaAdkTraceEntry['outputs']
): SophiaAdkTraceEntry {
  return {
    agent,
    decision,
    inputs,
    outputs,
    at: new Date().toISOString()
  };
}

function detectIntents(input: SophiaAdkDecisionInput): SophiaAdkIntent[] {
  const text = normalizedText(input);
  const intents = new Set<SophiaAdkIntent>();
  if (includesAny(text, ['refund', 'reembolso'])) intents.add('refund_status');
  if (includesAny(text, ['document', 'w-2', 'w2', 'upload', 'subir', 'documento'])) intents.add('document_upload');
  if (includesAny(text, ['document status', 'missing document', 'document_status'])) intents.add('document_status');
  if (includesAny(text, ['signature', 'sign', 'firma', 'signatures'])) intents.add('signature_status');
  if (includesAny(text, ['appointment', 'booking', 'cita', 'schedule', 'availability'])) intents.add('appointment_request');
  if (includesAny(text, ['when is my appointment', 'upcoming booking', 'booking_lookup'])) intents.add('appointment_lookup');
  if (includesAny(text, ['balance', 'payment', 'invoice', 'pago', 'saldo'])) intents.add('balance_or_payment');
  if (includesAny(text, ['update my', 'change my', 'address', 'phone number', 'contact_update'])) intents.add('contact_update');
  if (includesAny(text, ['transfer', 'extension', 'speak to', 'hablar con'])) intents.add('human_transfer');
  if (includesAny(text, ['call me back', 'callback', 'follow up', 'llamarme'])) intents.add('callback_request');
  if (includesAny(text, ['hours', 'address', 'services', 'office', 'horario', 'direccion', 'dirección'])) intents.add('general_office_question');
  if (includesAny(text, ['address', 'location', 'where are you', 'where is your office', 'office location', 'direccion', 'dirección', 'ubicacion', 'ubicación', 'donde estan', 'dónde están', 'donde esta', 'dónde está', 'donde queda', 'dónde queda'])) intents.add('office_location');
  if (includesAny(text, ['directions', 'how do i get there', 'how to get there', 'route', 'drive there', 'como llego', 'cómo llego', 'llegar'])) intents.add('directions');
  if (includesAny(text, ['parking', 'park', 'estacionamiento', 'parqueo'])) intents.add('parking');
  if (includesAny(text, ['near', 'nearby', 'landmark', 'close to', 'by the', 'cerca', 'referencia'])) intents.add('nearby_landmark');
  if (includesAny(text, ['map link', 'google maps', 'send me the map', 'text me the address', 'link del mapa', 'mandame el mapa', 'mándame el mapa'])) intents.add('map_link_request');
  if (input.summary?.outcomes.includes('booking_lookup_completed')) intents.add('appointment_lookup');
  if (input.summary?.outcomes.includes('document_status_checked')) intents.add('document_status');
  if (input.summary?.outcomes.includes('signature_status_checked')) intents.add('signature_status');
  if (input.summary?.outcomes.includes('callback_task_created')) intents.add('callback_request');
  if (input.summary?.escalationRequired) intents.add('callback_request');
  if (intents.size === 0) intents.add('unknown');
  return [...intents];
}

function buildSafety(input: SophiaAdkDecisionInput, intents: SophiaAdkIntent[]): SophiaAdkSafetyDecision {
  const text = normalizedText(input);
  const trustLevel = input.callerIdentity.trustLevel || 'unknown';
  const verified = trustLevel === 'verified_sensitive' || input.callerIdentity.identityStatus === 'pin_verified';
  const privateIntent = intents.some((intent) => intent === 'refund_status' || intent === 'document_status' || intent === 'signature_status' || intent === 'balance_or_payment' || intent === 'contact_update');
  const taxLegalAdviceBlocked = includesAny(text, [
    'should i claim',
    'can i deduct',
    'tax advice',
    'legal advice',
    'audit strategy',
    'debo reclamar',
    'puedo deducir'
  ]);
  const privateInfoBlocked = privateIntent && !verified;
  const reasons = [
    privateInfoBlocked ? 'private_info_requires_verification' : '',
    taxLegalAdviceBlocked ? 'tax_or_legal_advice_requires_staff' : ''
  ].filter(Boolean);
  return {
    privateInfoBlocked,
    requiresIdentityVerification: privateInfoBlocked,
    taxLegalAdviceBlocked,
    reasons
  };
}

function actionFromState(input: SophiaAdkDecisionInput, intents: SophiaAdkIntent[], safety: SophiaAdkSafetyDecision): SophiaAdkDecisionAction {
  if (safety.privateInfoBlocked) return 'block_private_info';
  if (safety.taxLegalAdviceBlocked) return 'safe_response_and_follow_up';
  if (input.context.voicemailAlreadyStarted) return 'voicemail';
  if (input.context.transferAlreadyAttempted) return 'transfer';
  if (input.summary?.followUpTaskId || input.context.callbackAlreadyCreated) return 'callback';
  if (input.summary?.escalationRequired) return 'safe_response_and_follow_up';
  if (intents.includes('human_transfer')) return 'transfer';
  if (intents.includes('callback_request')) return 'callback';
  if (input.source === 'post_call_finalization') return 'staff_review';
  return 'answer';
}

function handoffForAction(action: SophiaAdkDecisionAction, input: SophiaAdkDecisionInput, safety: SophiaAdkSafetyDecision) {
  if (safety.privateInfoBlocked) {
    return { needed: true, reason: 'private info requires caller verification', target: 'review' as const };
  }
  if (safety.taxLegalAdviceBlocked) {
    return { needed: true, reason: 'tax or legal advice requires staff follow-up', target: 'callback' as const };
  }
  if (action === 'transfer') return { needed: true, reason: 'caller requested staff transfer', target: 'staff' as const };
  if (action === 'voicemail') return { needed: true, reason: 'voicemail started or selected', target: 'voicemail' as const };
  if (action === 'callback') return { needed: true, reason: 'callback follow-up requested or created', target: 'callback' as const };
  if (input.summary?.escalationRequired) return { needed: true, reason: input.summary.escalationReasons.join(', ') || 'staff review requested', target: 'review' as const };
  return { needed: false, reason: null, target: null };
}

function toolPlanStep(tool: SophiaAdkToolName, purpose: string, executeNow: boolean): SophiaAdkToolPlanStep {
  return {
    tool,
    purpose,
    executeNow,
    canonicalPath: findSophiaAdkTool(tool).canonicalPath
  };
}

function buildToolPlan(input: SophiaAdkDecisionInput, intents: SophiaAdkIntent[], action: SophiaAdkDecisionAction, safety: SophiaAdkSafetyDecision): SophiaAdkToolPlanStep[] {
  const steps: SophiaAdkToolPlanStep[] = [];
  if (input.context.businessKnowledgeLoaded) {
    steps.push(toolPlanStep('getBusinessKnowledge', 'business knowledge was available to the voice session', false));
  }
  if (safety.requiresIdentityVerification) {
    steps.push(toolPlanStep('verifyCallerIdentity', 'verify caller before private status disclosure', action !== 'staff_review'));
  }
  if (intents.includes('appointment_request') || intents.includes('appointment_lookup')) {
    steps.push(toolPlanStep('lookupAppointmentAvailability', 'support appointment request or lookup', false));
  }
  if (
    intents.includes('office_location')
    || intents.includes('directions')
    || intents.includes('parking')
    || intents.includes('nearby_landmark')
    || intents.includes('map_link_request')
  ) {
    steps.push(toolPlanStep('GoogleMapsGroundingTool', 'ground verified Conecta office location with Google Maps', input.source === 'live_voice'));
  }
  if (intents.includes('document_status') || intents.includes('document_upload')) {
    steps.push(toolPlanStep('getDocumentStatus', 'support document status or upload question', false));
  }
  if (intents.includes('signature_status')) {
    steps.push(toolPlanStep('getSignatureStatus', 'support signature status question', false));
  }
  if (action === 'transfer') {
    steps.push(toolPlanStep('prepareUserTransfer', 'attempt staff browser transfer through canonical phone service', false));
    steps.push(toolPlanStep('fallbackToExternalPhone', 'use configured phone forwarding if browser phone is unavailable', false));
  }
  if (action === 'voicemail') {
    steps.push(toolPlanStep('transferToVoicemail', 'continue or record voicemail path', false));
  }
  if (action === 'callback' || action === 'safe_response_and_follow_up') {
    steps.push(toolPlanStep('createCallbackFollowUp', 'create or confirm staff follow-up', !input.context.callbackAlreadyCreated));
  }
  if (input.source === 'post_call_finalization') {
    steps.push(toolPlanStep('saveCallSummary', 'call finalizer persists summary through canonical phone session', false));
    steps.push(toolPlanStep('updateContactTimeline', 'call finalizer appends timeline activity', false));
  }
  return steps;
}

function buildStaffSummary(input: SophiaAdkDecisionInput, action: SophiaAdkDecisionAction, intents: SophiaAdkIntent[], safety: SophiaAdkSafetyDecision): string {
  const requestedTopic = input.summary?.requestedTopic || 'unknown topic';
  const safetyText = safety.reasons.length ? ` Safety: ${safety.reasons.join(', ')}.` : '';
  return `Sophia ADK Phase 1 decision: ${action}. Intents: ${intents.join(', ')}. Requested topic: ${requestedTopic}.${safetyText}`;
}

export function runSophiaAdkDecision(input: SophiaAdkDecisionInput): SophiaAdkDecisionOutput {
  const traceEntries: SophiaAdkTraceEntry[] = [];
  const intents = detectIntents(input);
  traceEntries.push(trace('LanguageIntentAgent', 'detected language and intents', {
    suppliedLanguage: input.language,
    source: input.source,
    messagePresent: input.message.trim().length > 0
  }, {
    language: input.language,
    intents
  }));

  traceEntries.push(trace('OfficeKnowledgeAgent', 'checked office knowledge availability', {
    orgIdPresent: input.orgId.trim().length > 0,
    source: input.source
  }, {
    businessKnowledgeLoaded: input.context.businessKnowledgeLoaded
  }));

  const safety = buildSafety(input, intents);
  traceEntries.push(trace('ComplianceSafetyAgent', 'evaluated privacy and advice boundaries', {
    trustLevel: input.callerIdentity.trustLevel,
    identityStatus: input.callerIdentity.identityStatus,
    intents
  }, {
    privateInfoBlocked: safety.privateInfoBlocked,
    requiresIdentityVerification: safety.requiresIdentityVerification,
    taxLegalAdviceBlocked: safety.taxLegalAdviceBlocked,
    reasons: safety.reasons
  }));

  const action = actionFromState(input, intents, safety);
  const handoff = handoffForAction(action, input, safety);
  traceEntries.push(trace('RoutingEscalationAgent', 'selected routing action', {
    transferAlreadyAttempted: input.context.transferAlreadyAttempted,
    voicemailAlreadyStarted: input.context.voicemailAlreadyStarted,
    callbackAlreadyCreated: input.context.callbackAlreadyCreated,
    escalationRequired: input.summary?.escalationRequired || false
  }, {
    action,
    handoffNeeded: handoff.needed,
    handoffTarget: handoff.target
  }));

  const toolPlan = buildToolPlan(input, intents, action, safety);
  traceEntries.push(trace('FollowUpActionAgent', 'planned canonical follow-up tools', {
    source: input.source,
    action
  }, {
    toolPlan: toolPlan.map((step) => step.tool)
  }));

  const staffSummary = buildStaffSummary(input, action, intents, safety);
  traceEntries.push(trace('SophiaOrchestratorAgent', 'coordinated final decision', {
    source: input.source,
    closeReason: input.context.closeReason
  }, {
    action,
    staffSummary
  }));

  return {
    orchestrationVersion: ORCHESTRATION_VERSION,
    action,
    language: input.language,
    intents,
    safety,
    handoff,
    toolPlan,
    finalInstructionForGeminiLive: input.source === 'live_voice' ? staffSummary : null,
    staffSummary,
    trace: traceEntries,
    usedAdkAgents: [
      'LanguageIntentAgent',
      'OfficeKnowledgeAgent',
      'ComplianceSafetyAgent',
      'RoutingEscalationAgent',
      'FollowUpActionAgent',
      'SophiaOrchestratorAgent'
    ]
  };
}

function hasOutcome(outcomes: SofiaReceptionistOutcomeType[], value: SofiaReceptionistOutcomeType): boolean {
  return outcomes.includes(value);
}

function hasEscalation(reasons: SofiaReceptionistEscalationReason[], value: SofiaReceptionistEscalationReason): boolean {
  return reasons.includes(value);
}

export function runSophiaAdkPostCallDecision(input: SophiaAdkPostCallInput): SophiaAdkDecisionOutput {
  const outcomes = input.summary.outcomes;
  const escalationReasons = input.summary.escalationReasons;
  const messageParts = [
    input.summary.requestedTopic || '',
    input.summary.nextRecommendedStaffAction,
    input.closeReason,
    ...input.summary.unresolvedIssues,
    ...outcomes,
    ...escalationReasons
  ];

  return runSophiaAdkDecision({
    orgId: input.orgId,
    channel: 'voice',
    source: 'post_call_finalization',
    message: messageParts.join(' '),
    language: input.summary.language,
    callerIdentity: {
      matchedContactId: input.summary.matchedContactId,
      identityStatus: input.identity.identityStatus || input.summary.identityStatus,
      trustLevel: input.identity.trustLevel || input.summary.trustLevel,
      verifiedFactors: input.identity.verifiedFactors
    },
    summary: input.summary,
    context: {
      closeReason: input.closeReason,
      currentDomain: null,
      businessKnowledgeLoaded: true,
      transferAlreadyAttempted: hasEscalation(escalationReasons, 'specific_human_requested'),
      voicemailAlreadyStarted: hasOutcome(outcomes, 'message_taken'),
      callbackAlreadyCreated: Boolean(input.summary.followUpTaskId) || hasOutcome(outcomes, 'callback_task_created')
    }
  });
}
