import type {
  SofiaReceptionistCallSummary,
  SofiaReceptionistEscalationReason,
  SofiaReceptionistOutcomeType,
  SofiaVoiceLanguage
} from '../../services/voice/voiceSessionTypes.ts';

export type SophiaAdkAgentName =
  | 'SophiaOrchestratorAgent'
  | 'LanguageIntentAgent'
  | 'OfficeKnowledgeAgent'
  | 'ComplianceSafetyAgent'
  | 'RoutingEscalationAgent'
  | 'FollowUpActionAgent';

export type SophiaAdkIntent =
  | 'appointment_request'
  | 'appointment_lookup'
  | 'document_upload'
  | 'document_status'
  | 'signature_status'
  | 'refund_status'
  | 'balance_or_payment'
  | 'contact_update'
  | 'human_transfer'
  | 'callback_request'
  | 'general_office_question'
  | 'office_location'
  | 'directions'
  | 'parking'
  | 'nearby_landmark'
  | 'map_link_request'
  | 'unknown';

export type SophiaAdkDecisionAction =
  | 'answer'
  | 'safe_response'
  | 'safe_response_and_follow_up'
  | 'transfer'
  | 'fallback_phone'
  | 'voicemail'
  | 'callback'
  | 'block_private_info'
  | 'staff_review';

export type SophiaAdkToolName =
  | 'getSofiaSettings'
  | 'getBusinessKnowledge'
  | 'GoogleMapsGroundingTool'
  | 'verifyCallerIdentity'
  | 'lookupAppointmentAvailability'
  | 'lookupUpcomingBookings'
  | 'createBooking'
  | 'cancelBooking'
  | 'rescheduleBooking'
  | 'getDocumentStatus'
  | 'getSignatureStatus'
  | 'prepareUserTransfer'
  | 'fallbackToExternalPhone'
  | 'transferToVoicemail'
  | 'createCallbackFollowUp'
  | 'saveCallSummary'
  | 'updateContactTimeline';

export type SophiaAdkTraceEntry = {
  agent: SophiaAdkAgentName;
  decision: string;
  inputs: Record<string, string | number | boolean | null | string[]>;
  outputs: Record<string, string | number | boolean | null | string[]>;
  at: string;
};

export type SophiaAdkSafetyDecision = {
  privateInfoBlocked: boolean;
  requiresIdentityVerification: boolean;
  taxLegalAdviceBlocked: boolean;
  reasons: string[];
};

export type SophiaAdkHandoffDecision = {
  needed: boolean;
  reason: string | null;
  target: 'staff' | 'callback' | 'voicemail' | 'review' | null;
};

export type SophiaAdkToolPlanStep = {
  tool: SophiaAdkToolName;
  purpose: string;
  executeNow: boolean;
  canonicalPath: string;
};

export type SophiaAdkDecisionInput = {
  orgId: string;
  channel: 'voice' | 'internal_chat' | 'website_chat';
  source: 'live_voice' | 'post_call_finalization' | 'eval';
  message: string;
  language: SofiaVoiceLanguage | null;
  callerIdentity: {
    matchedContactId: string | null;
    identityStatus: string | null;
    trustLevel: string | null;
    verifiedFactors: string[];
  };
  summary: Pick<
    SofiaReceptionistCallSummary,
    | 'callId'
    | 'sessionId'
    | 'requestedTopic'
    | 'outcomes'
    | 'escalationRequired'
    | 'escalationReasons'
    | 'unresolvedIssues'
    | 'nextRecommendedStaffAction'
    | 'followUpTaskId'
  > | null;
  context: {
    closeReason: string | null;
    currentDomain: string | null;
    businessKnowledgeLoaded: boolean;
    transferAlreadyAttempted: boolean;
    voicemailAlreadyStarted: boolean;
    callbackAlreadyCreated: boolean;
  };
};

export type SophiaAdkDecisionOutput = {
  orchestrationVersion: 'sophia_adk_phase_1';
  action: SophiaAdkDecisionAction;
  language: SofiaVoiceLanguage | null;
  intents: SophiaAdkIntent[];
  safety: SophiaAdkSafetyDecision;
  handoff: SophiaAdkHandoffDecision;
  toolPlan: SophiaAdkToolPlanStep[];
  finalInstructionForGeminiLive: string | null;
  staffSummary: string;
  trace: SophiaAdkTraceEntry[];
  usedAdkAgents: SophiaAdkAgentName[];
};

export type SophiaAdkToolExecutionInput = {
  sessionId: string | null;
  callId: string | null;
  orgId: string | null;
  activeDomain: string | null;
  geminiToolName: string;
  geminiToolCallId: string | null;
  canonicalHandler: string;
  canonicalTool: SophiaAdkToolName;
  toolArgs: Record<string, unknown>;
};

export type SophiaAdkToolExecutionOutput = {
  orchestrationVersion: 'sophia_adk_phase_2';
  agent: SophiaAdkAgentName;
  canonicalTool: SophiaAdkToolName;
  canonicalHandler: string;
  geminiToolName: string;
  shouldRunCanonicalHandler: true;
  decision: string;
  toolArgsShape: {
    keys: string[];
    keyCount: number;
  };
  trace: SophiaAdkTraceEntry[];
};

export type SophiaAdkPostCallInput = {
  orgId: string;
  closeReason: string;
  summary: SofiaReceptionistCallSummary;
  identity: {
    identityStatus: string | null;
    trustLevel: string | null;
    verifiedFactors: string[];
  };
};

export type SophiaAdkEvalCase = {
  id: string;
  input: SophiaAdkDecisionInput;
  expected: {
    intents: SophiaAdkIntent[];
    action: SophiaAdkDecisionAction;
    safetyReasons?: string[];
    escalationReasons?: SofiaReceptionistEscalationReason[];
    outcomes?: SofiaReceptionistOutcomeType[];
  };
};
