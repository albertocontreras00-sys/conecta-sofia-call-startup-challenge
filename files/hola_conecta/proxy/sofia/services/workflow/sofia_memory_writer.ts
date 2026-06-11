import crypto from 'crypto';
import type {
  SofiaComposedResponse,
  SofiaIdentityContext,
  SofiaInteractionEnvelope,
  SofiaPolicyDecision
} from '../../shared/sofiaWorkflow.ts';
import {
  createSofiaMemoryEntry,
  type SofiaAllowedDisclosureLevel,
  type SofiaConfidence,
  type SofiaSensitivity
} from '../../../models/sofiaMemoryEntriesModel.ts';
import { createSofiaWorkflowAuditEvent } from './sofia_audit_logger.ts';
import { logWarn } from '../../../utils/logger.js';

export interface SofiaMemoryWriterInput {
  envelope: SofiaInteractionEnvelope;
  identity: SofiaIdentityContext;
  policy: SofiaPolicyDecision;
  response?: SofiaComposedResponse | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}

type AllowedMemoryKind =
  | 'preferred_language'
  | 'preferred_channel'
  | 'last_interaction_summary'
  | 'prior_promise'
  | 'human_handoff_needed'
  | 'appointment_interest'
  | 'service_interest'
  | 'callback_requested';

type MemorySkipReason =
  | 'skipped_missing_org'
  | 'skipped_missing_actor'
  | 'skipped_sensitive'
  | 'skipped_unsupported_kind'
  | 'skipped_untrusted'
  | 'skipped_no_summary';

interface MemoryCandidateSpec {
  memoryKind: AllowedMemoryKind;
  summary: string | null;
  confidence: SofiaConfidence;
  sensitivity: SofiaSensitivity;
  allowedDisclosureLevel: SofiaAllowedDisclosureLevel;
  expiresAt: string | null;
}

const ALLOWED_KINDS = new Set<AllowedMemoryKind>([
  'preferred_language',
  'preferred_channel',
  'last_interaction_summary',
  'prior_promise',
  'human_handoff_needed',
  'appointment_interest',
  'service_interest',
  'callback_requested'
]);

const SENSITIVE_PATTERN = /(ssn|itin|passport|driver.?license|bank|routing|account number|credit card|debit card|cvv|pin|token|authorization|bearer|tax return|w-2|1099|payroll|document text|passport number|license number|full transcript|raw transcript|raw prompt|raw response)/i;

function normalizeText(input: string | null | undefined, maxLength = 1000): string | null {
  const value = String(input || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (SENSITIVE_PATTERN.test(value)) return null;
  return value.slice(0, maxLength);
}

function readBoolean(source: Record<string, unknown> | null | undefined, key: string): boolean {
  if (!source) return false;
  return source[key] === true;
}

function toFutureIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function languageLabel(language: string | null | undefined): string | null {
  const raw = String(language || '').trim().toLowerCase();
  if (!raw) return null;
  return raw.startsWith('es') ? 'Spanish' : 'English';
}

function createMemorySpecs(input: SofiaMemoryWriterInput): MemoryCandidateSpec[] {
  const specs: MemoryCandidateSpec[] = [];
  const language = languageLabel(input.identity.language || input.envelope.language);
  if (language) {
    specs.push({
      memoryKind: 'preferred_language',
      summary: normalizeText(`Preferred language is ${language}.`),
      confidence: 'high',
      sensitivity: 'low',
      allowedDisclosureLevel: 'low',
      expiresAt: null
    });
  }

  if (input.envelope.channel) {
    specs.push({
      memoryKind: 'preferred_channel',
      summary: normalizeText(`Preferred channel is ${input.envelope.channel}.`),
      confidence: 'medium',
      sensitivity: 'low',
      allowedDisclosureLevel: 'low',
      expiresAt: null
    });
  }

  const interactionSummary = normalizeText(input.summary);
  if (interactionSummary) {
    specs.push({
      memoryKind: 'last_interaction_summary',
      summary: interactionSummary,
      confidence: 'medium',
      sensitivity: 'low',
      allowedDisclosureLevel: 'verified_only',
      expiresAt: toFutureIso(30)
    });
  }

  if (input.policy.requiresHumanHandoff || readBoolean(input.metadata, 'requiresHumanHandoff')) {
    specs.push({
      memoryKind: 'human_handoff_needed',
      summary: normalizeText('Human handoff requested for recent interaction.'),
      confidence: 'high',
      sensitivity: 'medium',
      allowedDisclosureLevel: 'verified_only',
      expiresAt: toFutureIso(30)
    });
    specs.push({
      memoryKind: 'prior_promise',
      summary: normalizeText('Sofia indicated that a human teammate would follow up.'),
      confidence: 'medium',
      sensitivity: 'medium',
      allowedDisclosureLevel: 'verified_only',
      expiresAt: toFutureIso(30)
    });
  }

  if (readBoolean(input.metadata, 'bookingIntent')) {
    specs.push({
      memoryKind: 'appointment_interest',
      summary: normalizeText('User showed interest in booking an appointment.'),
      confidence: 'medium',
      sensitivity: 'low',
      allowedDisclosureLevel: 'low',
      expiresAt: toFutureIso(90)
    });
  }

  if (readBoolean(input.metadata, 'serviceInterest')) {
    specs.push({
      memoryKind: 'service_interest',
      summary: normalizeText('User asked about services or pricing.'),
      confidence: 'medium',
      sensitivity: 'low',
      allowedDisclosureLevel: 'low',
      expiresAt: toFutureIso(90)
    });
  }

  if (readBoolean(input.metadata, 'callbackRequested')) {
    specs.push({
      memoryKind: 'callback_requested',
      summary: normalizeText('User requested a callback or follow-up contact.'),
      confidence: 'high',
      sensitivity: 'medium',
      allowedDisclosureLevel: 'verified_only',
      expiresAt: toFutureIso(60)
    });
  }

  return specs;
}

function validateCandidate(input: SofiaMemoryWriterInput, candidate: MemoryCandidateSpec): MemorySkipReason | null {
  if (!input.envelope.orgId) return 'skipped_missing_org';
  if (!ALLOWED_KINDS.has(candidate.memoryKind)) return 'skipped_unsupported_kind';
  const actorContactId = input.identity.contactId ?? input.envelope.contactId ?? null;
  const actorUserId = input.identity.userId ?? input.envelope.userId ?? null;
  if (!actorContactId && !actorUserId) return 'skipped_missing_actor';
  if (input.identity.trustLevel === 'anonymous' && !actorContactId && !actorUserId) return 'skipped_untrusted';
  if (!candidate.summary) return 'skipped_no_summary';
  if (candidate.sensitivity !== 'low' && candidate.sensitivity !== 'medium') return 'skipped_sensitive';
  if (candidate.allowedDisclosureLevel !== 'low' && candidate.allowedDisclosureLevel !== 'verified_only') return 'skipped_sensitive';
  if (SENSITIVE_PATTERN.test(candidate.summary)) return 'skipped_sensitive';
  return null;
}

export async function persistSofiaMemoryCandidates(input: SofiaMemoryWriterInput): Promise<void> {
  const candidates = createMemorySpecs(input);
  const actorContactId = input.identity.contactId ?? input.envelope.contactId ?? null;
  const actorUserId = input.identity.userId ?? input.envelope.userId ?? null;

  if (candidates.length === 0) {
    await createSofiaWorkflowAuditEvent({
      envelope: input.envelope,
      identity: input.identity,
      eventType: 'memory_write_skipped',
      eventSummary: 'Skipped Sofia memory write: no candidate summary',
      metadata: {
        entryPoint: String(input.envelope.metadata?.entryPoint || 'unknown'),
        reason: 'skipped_no_summary',
        status: 'skipped'
      }
    });
    return;
  }

  for (const candidate of candidates) {
    const skipReason = validateCandidate(input, candidate);
    if (skipReason) {
      await createSofiaWorkflowAuditEvent({
        envelope: input.envelope,
        identity: input.identity,
        eventType: 'memory_write_skipped',
        eventSummary: `Skipped Sofia memory write: ${skipReason}`,
        metadata: {
          entryPoint: String(input.envelope.metadata?.entryPoint || 'unknown'),
          memoryKind: candidate.memoryKind,
          reason: skipReason,
          status: 'skipped'
        }
      });
      continue;
    }

    try {
      const row = await createSofiaMemoryEntry({
        id: crypto.randomUUID(),
        orgId: input.envelope.orgId,
        contactId: actorContactId,
        userId: actorUserId,
        householdId: input.identity.householdId ?? null,
        memoryKind: candidate.memoryKind,
        memorySummary: candidate.summary || '',
        sourceEventId: null,
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        allowedDisclosureLevel: candidate.allowedDisclosureLevel,
        expiresAt: candidate.expiresAt,
        createdBySystem: 'sofia'
      });

      await createSofiaWorkflowAuditEvent({
        envelope: input.envelope,
        identity: input.identity,
        eventType: 'memory_written',
        eventSummary: 'Sofia memory entry created',
        metadata: {
          entryPoint: String(input.envelope.metadata?.entryPoint || 'unknown'),
          memoryKind: candidate.memoryKind,
          confidence: candidate.confidence,
          allowedDisclosureLevel: candidate.allowedDisclosureLevel,
          status: row ? 'written' : 'skipped'
        }
      });
    } catch (error) {
      logWarn('sofia_memory_writer', 'Failed to write Sofia memory candidate', {
        orgId: input.envelope.orgId,
        memoryKind: candidate.memoryKind,
        error: error instanceof Error ? error.message : String(error)
      });
      await createSofiaWorkflowAuditEvent({
        envelope: input.envelope,
        identity: input.identity,
        eventType: 'memory_write_skipped',
        eventSummary: 'Skipped Sofia memory write due to persistence error',
        metadata: {
          entryPoint: String(input.envelope.metadata?.entryPoint || 'unknown'),
          memoryKind: candidate.memoryKind,
          reason: 'skipped_sensitive',
          status: 'skipped',
          errorCode: error instanceof Error ? error.name : 'MemoryWriteError'
        }
      });
    }
  }
}
