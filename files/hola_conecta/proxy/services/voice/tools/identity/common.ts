export const PENDING_TTL_MS = 5 * 60 * 1000;

export { auditMetadata, writeAudit } from './audit.ts';
export { findDifferentActiveEmailContact, findDuplicateActiveEmailContact, loadContact } from './contactLookup.ts';
export {
  customPoliciesFromContact,
  isClientVisibleCustomMetadata,
  loadCustomFieldMetadata,
  loadCustomPoliciesForContact,
  type CustomMetadata,
  UUID_REGEX
} from './customFieldPolicies.ts';
export {
  booleanValue,
  displayName,
  formatValueForSpeech,
  maskFieldValue,
  normalizeUpdateValue,
  rawFieldValue,
  stringValue
} from './fieldValues.ts';
export { logIdentityBoundary } from './identityLogging.ts';
export {
  blockResponse,
  duplicateEmailResponse,
  isPinVerified,
  requireCrmDomain,
  requireMatchedIdentity
} from './identityResponses.ts';
export { buildFieldReadModel, buildReadModel, requestedFieldKeys } from './readModel.ts';
