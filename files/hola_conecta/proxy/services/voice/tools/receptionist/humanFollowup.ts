import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import {
  markReceptionistEscalation,
  type SofiaReceptionistEscalationReason
} from '../../sofiaReceptionistOutcome.ts';
import {
  blockResponse,
  logReceptionistBoundary,
  requireDomain,
  type SofiaReceptionistVoiceToolContext
} from './common.ts';

function escalationReason(value: string | null): SofiaReceptionistEscalationReason | null {
  switch (value) {
    case 'unsupported_request':
    case 'specific_human_requested':
    case 'caller_angry_or_urgent':
    case 'ambiguous_identity':
    case 'important_tool_failure':
    case 'restricted_advice_or_judgment':
    case 'repeated_failed_attempts':
    case 'document_signature_status_confusing':
    case 'portal_access_problem':
    case 'callback_request':
      return value;
    default:
      return null;
  }
}

export async function handleRequestHumanFollowupTool(
  context: SofiaReceptionistVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'request_human_followup';
  logReceptionistBoundary(context, 'voice.mcp.handoff.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireDomain(context, ['orchestrator', 'identity', 'appointments', 'profile', 'documents', 'signatures', 'tasks', 'handoff'], toolName, toolCallId)) return;
  const session = context.session;
  if (!session) return;
  const reason = escalationReason(stringArg(args, 'reason'));
  const topic = stringArg(args, 'topic') || 'Caller needs office follow-up.';
  if (!reason) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('INVALID_ESCALATION_REASON', 'Use one of the supported escalation reasons.'));
    return;
  }
  session.sofiaReceptionist.requestedHumanOrTopic = topic;
  if (!session.sofiaReceptionist.requestedTopic) session.sofiaReceptionist.requestedTopic = topic;
  markReceptionistEscalation(session, reason, topic);
  logReceptionistBoundary(context, 'voice.mcp.handoff.response_shape', toolName, toolCallId, {
    escalationRecorded: true,
    escalationReason: reason,
    topic,
    receptionistState: session.sofiaReceptionist
  });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    escalationRecorded: true,
    escalationReason: reason,
    topic,
    message: 'Sofia should acknowledge the office will follow up. The bridge will create a staff follow-up task when the call finalizes.'
  });
}
