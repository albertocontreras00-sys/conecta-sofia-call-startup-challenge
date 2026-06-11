import crypto from 'node:crypto';
import { emitContactTimelineEvent } from '../../../contacts/contactTimelineService.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import type { SofiaIdentityCrmVoiceToolContext } from './types.ts';
import { blockResponse, isPinVerified, logIdentityBoundary, PENDING_TTL_MS, requireCrmDomain, requireMatchedIdentity, writeAudit } from './common.ts';
export async function handlePrepareContactNoteOrTaskTool(
  context: SofiaIdentityCrmVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'prepare_contact_note_or_task';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  if (!isPinVerified(context.callerIdentity)) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PIN_REQUIRED', 'Verify the caller PIN before preparing a note or task.'));
    return;
  }
  const kind = stringArg(args, 'kind') === 'task' ? 'task' : 'note';
  const body = stringArg(args, 'body');
  if (!body) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('BODY_REQUIRED', 'A concise caller-approved note or task body is required.'));
    return;
  }
  const token = crypto.randomUUID();
  const confirmationText = `Please confirm: add this ${kind}: ${body}`;
  context.pendingContactNotesOrTasks.set(token, {
    token,
    contactId,
    kind,
    body,
    confirmationText,
    expiresAt: Date.now() + PENDING_TTL_MS
  });
  logIdentityBoundary(context, 'voice.mcp.profile.prepare_note_or_task.response_shape', toolName, toolCallId, {
    token,
    contactId,
    kind,
    pendingSize: context.pendingContactNotesOrTasks.size
  });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    noteOrTaskToken: token,
    kind,
    confirmationText,
    message: 'Ask for explicit confirmation before commit_contact_note_or_task.'
  });
}

export async function handleCommitContactNoteOrTaskTool(
  context: SofiaIdentityCrmVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'commit_contact_note_or_task';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity,
    pendingContactNotesOrTasksSize: context.pendingContactNotesOrTasks.size
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  if (!isPinVerified(context.callerIdentity)) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PIN_REQUIRED', 'Verify the caller PIN before committing a note or task.'));
    return;
  }
  const token = stringArg(args, 'noteOrTaskToken');
  const confirmationReceived = args.confirmationReceived === true;
  const pending = token ? context.pendingContactNotesOrTasks.get(token) : null;
  if (!pending || pending.contactId !== contactId || pending.expiresAt < Date.now()) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PENDING_NOTE_OR_TASK_NOT_FOUND', 'Prepare the note or task again before committing it.'));
    return;
  }
  if (!confirmationReceived) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONFIRMATION_REQUIRED', 'Do not add the note or task until the caller explicitly confirms it.'));
    return;
  }
  await emitContactTimelineEvent({
    orgId: context.session.orgId,
    contactId,
    eventType: pending.kind === 'task' ? 'sofia.voice_task' : 'sofia.voice_note',
    actorType: 'system',
    body: pending.body,
    metadata: {
      source: 'sofia_voice_identity_crm',
      callId: context.session.callId,
      sessionId: context.session.sessionId
    }
  });
  context.pendingContactNotesOrTasks.delete(pending.token);
  logIdentityBoundary(context, 'voice.mcp.profile.commit_note_or_task.response_shape', toolName, toolCallId, {
    contactId,
    pending,
    remainingPendingSize: context.pendingContactNotesOrTasks.size
  });
  await writeAudit({ context, contactId, fieldKey: pending.kind, action: `create_${pending.kind}`, newValue: pending.body, toolName, sensitivity: 'medium' });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    contactId,
    kind: pending.kind,
    message: `The confirmed ${pending.kind} was saved.`
  });
}

