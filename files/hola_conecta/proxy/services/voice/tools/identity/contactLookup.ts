import * as contactModel from '../../../../models/contact/index.ts';
import type { ContactRecord } from './types.ts';

export async function loadContact(orgId: string, contactId: string): Promise<ContactRecord | null> {
  return await contactModel.findContactById(contactId, orgId) as ContactRecord | null;
}

export function findDifferentActiveEmailContact(matches: ContactRecord[], contactId: string): ContactRecord | null {
  return matches.find((match) => {
    const matchId = String(match.id || '');
    return matchId && matchId !== contactId && !match.deleted_at;
  }) || null;
}

export async function findDuplicateActiveEmailContact(orgId: string, contactId: string, email: string): Promise<ContactRecord | null> {
  const matches = await contactModel.findContactsByEmail(orgId, email) as ContactRecord[];
  return findDifferentActiveEmailContact(matches, contactId);
}
