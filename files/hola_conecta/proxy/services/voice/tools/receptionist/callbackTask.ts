import { logError } from '../../../../utils/logger.js';
import { sql } from '../../../../db/neon.js';
import * as taskService from '../../../tasks/taskService.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import {
  blockResponse,
  logReceptionistBoundary,
  requireDomain,
  type SofiaReceptionistVoiceToolContext
} from './common.ts';

type CallbackAssigneeSource = 'contact_assigned_user' | 'account_owner';
type CallbackAssignee = {
  userId: string;
  displayName: string | null;
  source: CallbackAssigneeSource;
  contactAssignedTo: string | null;
  contactAssignedToValid: boolean;
};
type CallbackContactAssigneeRow = {
  assigned_to: string | null;
  assigned_user_id: string | null;
  assigned_user_display_name: string | null;
};
type CallbackOwnerRow = {
  user_id: string;
  owner_display_name: string | null;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function callbackTitle(displayName: string | null, phone: string | null): string {
  const subject = displayName || phone || 'caller';
  return `Call back: ${subject}`;
}

async function resolveCallbackAssignee(orgId: string, contactId: string | null): Promise<CallbackAssignee | null> {
  let contactAssignedTo: string | null = null;
  let contactAssignedToValid = false;

  if (contactId) {
    const contactRows = await sql`
      SELECT
        c.assigned_to,
        u.id::text AS assigned_user_id,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.email) AS assigned_user_display_name
      FROM contacts c
      LEFT JOIN users u
        ON c.assigned_to ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND u.id = c.assigned_to::uuid
       AND u.org_id = c.org_id
       AND u.deleted_at IS NULL
      WHERE c.org_id = ${orgId}::uuid
        AND c.id = ${contactId}::uuid
        AND c.deleted_at IS NULL
      LIMIT 1
    ` as CallbackContactAssigneeRow[];
    const contactRow = contactRows[0] || null;
    contactAssignedTo = contactRow?.assigned_to || null;
    contactAssignedToValid = Boolean(contactAssignedTo && UUID_REGEX.test(contactAssignedTo));
    if (contactRow?.assigned_user_id) {
      return {
        userId: contactRow.assigned_user_id,
        displayName: contactRow.assigned_user_display_name || null,
        source: 'contact_assigned_user',
        contactAssignedTo,
        contactAssignedToValid
      };
    }
  }

  const ownerRows = await sql`
    SELECT
      m.user_id::text AS user_id,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.email) AS owner_display_name
    FROM membership m
    JOIN users u
      ON u.id = m.user_id
     AND u.org_id = m.org_id
     AND u.deleted_at IS NULL
    WHERE m.org_id = ${orgId}::uuid
      AND m.role = 'owner'
      AND m.is_active = true
    ORDER BY m.created_at ASC
    LIMIT 1
  ` as CallbackOwnerRow[];
  const owner = ownerRows[0] || null;
  if (!owner) return null;
  return {
    userId: owner.user_id,
    displayName: owner.owner_display_name || null,
    source: 'account_owner',
    contactAssignedTo,
    contactAssignedToValid
  };
}

export async function handleCreateCallbackTaskTool(
  context: SofiaReceptionistVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'create_callback_task';
  logReceptionistBoundary(context, 'voice.mcp.tasks.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireDomain(context, ['tasks', 'orchestrator'], toolName, toolCallId)) return;
  const session = context.session;
  if (!session) return;
  const confirmationReceived = args.confirmationReceived === true;
  if (!confirmationReceived) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONFIRMATION_REQUIRED', 'Ask the caller to confirm the callback request before creating the task.'));
    return;
  }
  const details = stringArg(args, 'details') || 'Caller requested a callback from the office.';
  const identity = context.callerIdentity;
  const contactId = identity?.identityStatus !== 'ambiguous_phone_match' ? identity?.contactId || null : null;
  if (identity?.identityStatus === 'ambiguous_phone_match') {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('AMBIGUOUS_PHONE_MATCH', 'The caller phone matches multiple contacts. Do not create a contact-specific task. Offer human follow-up.'));
    return;
  }
  try {
    const assignee = await resolveCallbackAssignee(session.orgId, contactId);
    if (!assignee) {
      logReceptionistBoundary(context, 'voice.mcp.tasks.callback_assignment_failed', toolName, toolCallId, {
        orgId: session.orgId,
        contactId,
        reason: 'no_active_contact_assignee_or_account_owner'
      });
      context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CALLBACK_ASSIGNEE_NOT_FOUND', 'Sofia could not determine the staff member responsible for the callback. Do not claim the task was created; offer human follow-up.'));
      return;
    }
    const task = await taskService.createTask({
      org_id: session.orgId,
      title: callbackTitle(identity?.displayName || null, session.fromPhone),
      description: [
        details,
        '',
        'Source: Sofia voice',
        `Call ID: ${session.callId}`,
        `Session ID: ${session.sessionId}`,
        `Caller phone: ${session.fromPhone || 'unknown'}`
      ].join('\n'),
      status: 'todo',
      priority: 'medium',
      assignee_id: assignee.userId,
      contact_id: contactId,
      task_type: 'sofia_callback'
    }, session.callId || null);
    logReceptionistBoundary(context, 'voice.mcp.tasks.response_shape', toolName, toolCallId, {
      task,
      callbackAssignment: {
        assigneeId: assignee.userId,
        assigneeDisplayName: assignee.displayName,
        assigneeSource: assignee.source,
        contactAssignedTo: assignee.contactAssignedTo,
        contactAssignedToValid: assignee.contactAssignedToValid
      }
    });
    context.sendGeminiToolResponse(toolName, toolCallId, {
      ok: true,
      taskId: task.id,
      title: task.title,
      contactId: task.contact_id || null,
      assigneeId: assignee.userId,
      assigneeDisplayName: assignee.displayName,
      assigneeSource: assignee.source,
      message: assignee.displayName
        ? `The callback task was created and assigned to ${assignee.displayName}. If the caller asks who will call back, say ${assignee.displayName}.`
        : 'The callback task was created and assigned to the responsible account owner. If the caller asks who will call back, say the account owner.'
    });
  } catch (error) {
    logError(context.logContext, 'voice.gemini.create_callback_task_failed', error, {
      orgId: session.orgId,
      sessionId: session.sessionId,
      callId: session.callId,
      contactId
    });
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CREATE_CALLBACK_TASK_FAILED', 'Sofia could not create the callback task. Do not claim it was created; offer human follow-up.'));
  }
}
