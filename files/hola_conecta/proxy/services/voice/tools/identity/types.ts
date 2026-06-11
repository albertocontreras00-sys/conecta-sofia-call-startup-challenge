import type { SofiaIdentityResolutionResult } from '../../../../sofia/sofia_identity_agent/identityTypes.ts';
import type { JsonObject, JsonValue } from '../../../../types/json.ts';
import type { GeminiDomain } from '../../infobipMediaWebSocketGeminiTypes.ts';
import type { VoiceSession } from '../../voiceSessionTypes.ts';
import type { SendGeminiToolResponse } from '../booking/common.ts';
import type { FieldSensitivity, FieldSource } from './fieldPolicies.ts';

export type ContactRecord = JsonObject & {
  id?: JsonValue;
  first_name?: JsonValue;
  last_name?: JsonValue;
  email?: JsonValue;
  phone?: JsonValue;
  address_line1?: JsonValue;
  address_line2?: JsonValue;
  city?: JsonValue;
  state?: JsonValue;
  postal_code?: JsonValue;
  birthday?: JsonValue;
  preferred_language?: JsonValue;
  sms_opt_in?: JsonValue;
  email_opt_in?: JsonValue;
  whatsapp_opt_in?: JsonValue;
  household_id?: JsonValue;
  household_role?: JsonValue;
  deleted_at?: JsonValue;
  custom_fields?: JsonObject;
  custom_field_metadata?: Record<string, JsonObject>;
};

export type FieldReadModel = {
  key: string;
  label: string;
  source: FieldSource;
  maskedValue: string | null;
  value?: JsonValue;
  sensitivity: FieldSensitivity;
  canReadByVoice: boolean;
  canUpdateByVoice: boolean;
};

export type SofiaPendingContactFieldUpdate = {
  token: string;
  contactId: string;
  fieldKey: string;
  source: FieldSource;
  oldValue: JsonValue;
  newValue: JsonValue;
  confirmationText: string;
  expiresAt: number;
};

export type SofiaPendingContactNoteOrTask = {
  token: string;
  contactId: string;
  kind: 'note' | 'task';
  body: string;
  confirmationText: string;
  expiresAt: number;
};

export type SofiaIdentityCrmVoiceToolContext = {
  activeGeminiDomain: GeminiDomain;
  callerIdentity: SofiaIdentityResolutionResult | null;
  logContext: string;
  pendingContactFieldUpdates: Map<string, SofiaPendingContactFieldUpdate>;
  pendingContactNotesOrTasks: Map<string, SofiaPendingContactNoteOrTask>;
  sendGeminiToolResponse: SendGeminiToolResponse;
  session: VoiceSession | null;
};
