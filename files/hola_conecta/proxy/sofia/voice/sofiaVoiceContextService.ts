import { sql } from '../../db/neon.js';
import * as contactModel from '../../models/contact/index.ts';
import { normalizeVoiceLanguage } from './sofiaVoiceLanguage.ts';
import type { SofiaVoiceLanguage } from '../../services/voice/voiceSessionTypes.ts';

type VoiceContactMatch = {
  id?: string | null;
  first_name?: string | null;
  preferred_language?: string | null;
  deleted_at?: unknown;
};

export type SofiaVoiceResolvedContext = {
  firstName: string | null;
  preferredLanguage: SofiaVoiceLanguage;
  officeName: string | null;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function resolveSofiaVoiceContext(input: {
  orgId: string;
  callerPhone: string;
}): Promise<SofiaVoiceResolvedContext> {
  const [contacts, orgRows] = await Promise.all([
    contactModel.findContactsByPhone(input.orgId, input.callerPhone) as Promise<VoiceContactMatch[]>,
    sql`SELECT client_portal_business_name FROM org WHERE id = ${input.orgId}::uuid LIMIT 1`
  ]);
  const active = contacts.filter((contact) => !contact.deleted_at);
  const uniqueContact = active.length === 1 ? active[0] : null;
  const officeName = nonEmptyString(orgRows[0]?.client_portal_business_name);
  return {
    firstName: nonEmptyString(uniqueContact?.first_name),
    preferredLanguage: normalizeVoiceLanguage(uniqueContact?.preferred_language),
    officeName
  };
}
