import crypto from 'node:crypto';
import { logError } from '../../../../utils/logger.js';
import { updateContact } from '../../../contacts/contactMutationService.ts';
import { upsertEntityCustomFieldsByMetadataId } from '../../../custom-fields/entityCustomFieldWriteService.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import { STANDARD_POLICY_BY_KEY } from './fieldPolicies.ts';
import type { SofiaIdentityCrmVoiceToolContext } from './types.ts';
import { blockResponse, duplicateEmailResponse, findDuplicateActiveEmailContact, formatValueForSpeech, isPinVerified, loadContact, loadCustomFieldMetadata, logIdentityBoundary, maskFieldValue, normalizeUpdateValue, PENDING_TTL_MS, rawFieldValue, requireCrmDomain, requireMatchedIdentity, UUID_REGEX, writeAudit } from './common.ts';
export async function handlePrepareContactFieldUpdateTool(
  context: SofiaIdentityCrmVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'prepare_contact_field_update';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  if (!isPinVerified(context.callerIdentity)) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PIN_REQUIRED', 'Ask for and verify the caller voice PIN before preparing profile updates.'));
    return;
  }
  const fieldKey = stringArg(args, 'fieldKey');
  const rawNewValue = stringArg(args, 'newValue');
  if (!fieldKey) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('FIELD_KEY_REQUIRED', 'fieldKey is required and must be one of list_available_contact_fields.'));
    return;
  }
  const contact = await loadContact(context.session.orgId, contactId);
  if (!contact) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONTACT_NOT_FOUND', 'The matched contact no longer exists.'));
    return;
  }
  let policy = STANDARD_POLICY_BY_KEY.get(fieldKey) || null;
  if (!policy && UUID_REGEX.test(fieldKey)) {
    policy = await loadCustomFieldMetadata(context.session.orgId, fieldKey);
  }
  if (!policy || !policy.canUpdateWithPin) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('FIELD_NOT_UPDATEABLE_BY_VOICE', 'This field is not explicitly allowlisted for Sofia voice updates.'));
    return;
  }
  try {
    const newValue = normalizeUpdateValue(policy, rawNewValue);
    const oldValue = policy.source === 'custom_field_values' ? contact.custom_fields?.[policy.key] ?? null : rawFieldValue(contact, policy.key);
    if (policy.key === 'email' && typeof newValue === 'string') {
      const duplicateContact = await findDuplicateActiveEmailContact(context.session.orgId, contactId, newValue);
      if (duplicateContact) {
        logIdentityBoundary(context, 'voice.mcp.profile.email_duplicate_blocked', toolName, toolCallId, {
          contactId,
          duplicateContactId: duplicateContact.id || null,
          fieldKey: policy.key
        });
        context.sendGeminiToolResponse(toolName, toolCallId, duplicateEmailResponse());
        return;
      }
    }
    const token = crypto.randomUUID();
    const confirmationText = `Please confirm: update ${policy.label} from ${formatValueForSpeech(oldValue)} to ${formatValueForSpeech(newValue)}.`;
    context.pendingContactFieldUpdates.set(token, {
      token,
      contactId,
      fieldKey: policy.key,
      source: policy.source,
      oldValue,
      newValue,
      confirmationText,
      expiresAt: Date.now() + PENDING_TTL_MS
    });
    logIdentityBoundary(context, 'voice.mcp.profile.prepare_update.response_shape', toolName, toolCallId, {
      token,
      contactId,
      policy,
      oldValue,
      newValue,
      pendingSize: context.pendingContactFieldUpdates.size
    });
    context.sendGeminiToolResponse(toolName, toolCallId, {
      ok: true,
      updateToken: token,
      contactId,
      fieldKey: policy.key,
      label: policy.label,
      oldValueMasked: maskFieldValue(policy.key, oldValue),
      newValueMasked: maskFieldValue(policy.key, newValue),
      confirmationText,
      message: 'Ask the caller to explicitly confirm the exact change before commit_contact_field_update.'
    });
  } catch (error) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse(error instanceof Error ? error.message : 'INVALID_FIELD_VALUE', 'The proposed value is invalid for this field.'));
  }
}

export async function handleCommitContactFieldUpdateTool(
  context: SofiaIdentityCrmVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'commit_contact_field_update';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity,
    pendingContactFieldUpdatesSize: context.pendingContactFieldUpdates.size
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  if (!isPinVerified(context.callerIdentity)) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PIN_REQUIRED', 'Verify the caller voice PIN before committing profile updates.'));
    return;
  }
  const token = stringArg(args, 'updateToken');
  const confirmationReceived = args.confirmationReceived === true;
  const pending = token ? context.pendingContactFieldUpdates.get(token) : null;
  if (!pending || pending.contactId !== contactId || pending.expiresAt < Date.now()) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PENDING_UPDATE_NOT_FOUND', 'Prepare the update again before committing it.'));
    return;
  }
  if (!confirmationReceived) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONFIRMATION_REQUIRED', 'Do not update the profile until the caller explicitly confirms the exact change.'));
    return;
  }
  try {
    if (pending.fieldKey === 'email' && typeof pending.newValue === 'string') {
      const duplicateContact = await findDuplicateActiveEmailContact(context.session.orgId, contactId, pending.newValue);
      if (duplicateContact) {
        context.pendingContactFieldUpdates.delete(pending.token);
        logIdentityBoundary(context, 'voice.mcp.profile.email_duplicate_blocked', toolName, toolCallId, {
          contactId,
          duplicateContactId: duplicateContact.id || null,
          fieldKey: pending.fieldKey,
          remainingPendingSize: context.pendingContactFieldUpdates.size
        });
        context.sendGeminiToolResponse(toolName, toolCallId, duplicateEmailResponse());
        return;
      }
    }
    if (pending.source === 'custom_field_values') {
      await upsertEntityCustomFieldsByMetadataId({
        orgId: context.session.orgId,
        entityType: 'contact',
        entityId: contactId,
        valuesByFieldMetadataId: { [pending.fieldKey]: pending.newValue }
      });
    } else {
      await updateContact(contactId, context.session.orgId, { [pending.fieldKey]: pending.newValue });
    }
    context.pendingContactFieldUpdates.delete(pending.token);
    logIdentityBoundary(context, 'voice.mcp.profile.commit_update.response_shape', toolName, toolCallId, {
      contactId,
      pending,
      remainingPendingSize: context.pendingContactFieldUpdates.size
    });
    await writeAudit({
      context,
      contactId,
      fieldKey: pending.fieldKey,
      action: 'update_field',
      oldValue: pending.oldValue,
      newValue: pending.newValue,
      toolName,
      sensitivity: 'high'
    });
    context.sendGeminiToolResponse(toolName, toolCallId, {
      ok: true,
      contactId,
      fieldKey: pending.fieldKey,
      oldValueMasked: maskFieldValue(pending.fieldKey, pending.oldValue),
      newValueMasked: maskFieldValue(pending.fieldKey, pending.newValue),
      message: 'The confirmed profile update was saved.'
    });
  } catch (error) {
    logError(context.logContext, 'voice.gemini.identity_crm_update_failed', error, {
      orgId: context.session.orgId,
      contactId,
      fieldKey: pending.fieldKey
    });
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONTACT_UPDATE_FAILED', 'The confirmed profile update could not be saved. Offer human follow-up.'));
  }
}

