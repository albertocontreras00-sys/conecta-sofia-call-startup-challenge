import type { SofiaIdentityResolutionResult } from '../../../../sofia/sofia_identity_agent/identityTypes.ts';
import {
  STANDARD_POLICIES,
  type ContactFieldPolicy,
} from './fieldPolicies.ts';
import type { ContactRecord, FieldReadModel } from './types.ts';
import { customPoliciesFromContact, type CustomMetadata } from './customFieldPolicies.ts';
import { displayName, maskFieldValue, rawFieldValue } from './fieldValues.ts';
import { isPinVerified } from './identityResponses.ts';

export function buildFieldReadModel(policy: ContactFieldPolicy, contact: ContactRecord, pinVerified: boolean): FieldReadModel {
  const value = policy.source === 'custom_field_values'
    ? contact.custom_fields?.[policy.key] ?? null
    : rawFieldValue(contact, policy.key);
  const canReadByVoice = pinVerified ? policy.canReadWithPin : policy.canReadBeforePin;
  const field: FieldReadModel = {
    key: policy.key,
    label: policy.label,
    source: policy.source,
    maskedValue: maskFieldValue(policy.key, value),
    sensitivity: policy.sensitivity,
    canReadByVoice,
    canUpdateByVoice: pinVerified && policy.canUpdateWithPin
  };
  if (canReadByVoice && pinVerified && policy.key !== 'phone_last4' && policy.key !== 'email_domain') {
    field.value = value;
  }
  return field;
}

export function buildReadModel(
  identity: SofiaIdentityResolutionResult,
  contact: ContactRecord,
  requestedKeys: string[] | null,
  customPolicies: CustomMetadata[] = customPoliciesFromContact(contact)
) {
  const pinVerified = isPinVerified(identity);
  const policies = [...STANDARD_POLICIES, ...customPolicies];
  const requested = requestedKeys && requestedKeys.length ? new Set(requestedKeys) : null;
  const fields = policies
    .filter((policy) => !requested || requested.has(policy.key))
    .map((policy) => buildFieldReadModel(policy, contact, pinVerified));

  return {
    contactId: String(contact.id || identity.contactId || ''),
    displayName: displayName(contact) || identity.displayName,
    identityStatus: identity.identityStatus,
    trustLevel: identity.trustLevel,
    verifiedFactors: identity.verifiedFactors,
    fields
  };
}

export function requestedFieldKeys(args: Record<string, unknown>): string[] | null {
  const raw = args.fieldKeys;
  if (!Array.isArray(raw)) return null;
  return raw.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim());
}
