import type { JsonValue } from '../../../../types/json.ts';
import type { ContactFieldPolicy } from './fieldPolicies.ts';
import type { ContactRecord } from './types.ts';

export function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function booleanValue(value: JsonValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function displayName(contact: ContactRecord): string | null {
  return [stringValue(contact.first_name), stringValue(contact.last_name)].filter(Boolean).join(' ') || null;
}

export function rawFieldValue(contact: ContactRecord, key: string): JsonValue {
  if (key === 'phone_last4') {
    const digits = String(contact.phone || '').replace(/\D/g, '');
    return digits ? digits.slice(-4) : null;
  }
  if (key === 'email_domain') {
    const email = stringValue(contact.email);
    const domain = email?.split('@')[1]?.trim().toLowerCase();
    return domain || null;
  }
  return contact[key] ?? null;
}

export function maskFieldValue(key: string, value: JsonValue): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (key === 'phone' || key === 'phone_last4') {
    const digits = String(value).replace(/\D/g, '');
    return digits ? `ending in ${digits.slice(-4)}` : null;
  }
  if (key === 'email' || key === 'email_domain') {
    const text = String(value);
    const domain = key === 'email_domain' ? text : text.split('@')[1] || '';
    return domain ? `at ${domain}` : null;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export function normalizeUpdateValue(policy: ContactFieldPolicy, rawValue: string | null): JsonValue {
  if (rawValue === null) return null;
  if (policy.key === 'sms_opt_in' || policy.key === 'email_opt_in' || policy.key === 'whatsapp_opt_in') {
    const normalized = rawValue.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'opt in'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0', 'off', 'opt out'].includes(normalized)) return false;
    throw new Error('INVALID_BOOLEAN_VALUE');
  }
  if (policy.key === 'email') {
    const normalized = rawValue.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('INVALID_EMAIL_VALUE');
    return normalized;
  }
  if (policy.key === 'phone') {
    const digits = rawValue.replace(/\D/g, '');
    if (digits.length < 10) throw new Error('INVALID_PHONE_VALUE');
    return rawValue.trim();
  }
  return rawValue.trim() || null;
}

export function formatValueForSpeech(value: JsonValue): string {
  if (value === null || value === undefined || value === '') return 'blank';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
