import { logError } from '../../../../utils/logger.js';
import * as esignEnvelopeModel from '../../../../models/esignEnvelopeModel.ts';
import { integerArg } from '../../sofiaVoiceToolArgs.ts';
import {
  asRecord,
  blockResponse,
  logReceptionistBoundary,
  requireDomain,
  requireSessionAndContact,
  statusValue,
  textValue,
  type RuntimeRecord,
  type SofiaReceptionistVoiceToolContext
} from './common.ts';

function summarizeSigner(signer: RuntimeRecord, contactId: string): RuntimeRecord {
  return {
    signerId: textValue(signer.id),
    contactId: textValue(signer.contact_id),
    name: textValue(signer.name),
    status: statusValue(signer.status),
    signingOrder: typeof signer.signing_order === 'number' ? signer.signing_order : null,
    isCaller: textValue(signer.contact_id) === contactId
  };
}

function summarizeEnvelope(envelope: RuntimeRecord, contactId: string): RuntimeRecord {
  const signers = Array.isArray(envelope.signers) ? envelope.signers.map((item) => summarizeSigner(asRecord(item), contactId)) : [];
  const pendingSigners = signers.filter((signer) => {
    const status = statusValue(signer.status);
    return status !== 'signed' && status !== 'declined';
  });
  const callerSigner = signers.find((signer) => signer.isCaller === true) || null;
  return {
    envelopeId: textValue(envelope.id),
    name: textValue(envelope.name) || textValue(envelope.title) || 'Signature request',
    status: statusValue(envelope.status),
    sentAt: textValue(envelope.sent_at),
    expiresAt: textValue(envelope.expires_at),
    pendingSignerCount: pendingSigners.length,
    callerSignerStatus: callerSigner ? statusValue(callerSigner.status) : null,
    nextActionText: callerSigner && statusValue(callerSigner.status) !== 'signed'
      ? 'The caller may still need to sign.'
      : pendingSigners.length > 0
        ? 'Another signer may still need to sign.'
        : 'No pending signer is shown for this envelope.'
  };
}

export async function handleListPendingSignaturesTool(
  context: SofiaReceptionistVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'list_pending_signatures';
  logReceptionistBoundary(context, 'voice.mcp.signatures.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireDomain(context, ['signatures', 'orchestrator'], toolName, toolCallId)) return;
  const identity = requireSessionAndContact(context, toolName, toolCallId);
  if (!identity) return;
  const limit = Math.min(Math.max(integerArg(args, 'limit') || 5, 1), 10);
  try {
    const envelopes = await esignEnvelopeModel.listEnvelopesByContact(identity.session.orgId, identity.contactId, { limit, offset: 0 });
    const summaries = envelopes.map((envelope) => summarizeEnvelope(asRecord(envelope), identity.contactId));
    const pending = summaries.filter((envelope) => {
      const status = statusValue(envelope.status);
      return status !== 'signed' && status !== 'completed' && status !== 'declined' && status !== 'cancelled';
    });
    logReceptionistBoundary(context, 'voice.mcp.signatures.response_shape', toolName, toolCallId, {
      envelopes,
      summaries,
      pending,
      pendingCount: pending.length
    });
    context.sendGeminiToolResponse(toolName, toolCallId, {
      ok: true,
      envelopes: pending,
      envelopeCount: pending.length,
      sensitiveDetailsRequirePin: true,
      message: pending.length
        ? 'Speak only the returned signature status summaries. Do not provide signing links, tokens, or document contents.'
        : 'No pending signature requests were found for the matched caller.'
    });
  } catch (error) {
    logError(context.logContext, 'voice.gemini.list_pending_signatures_failed', error, {
      orgId: identity.session.orgId,
      contactId: identity.contactId,
      sessionId: identity.session.sessionId,
      callId: identity.session.callId
    });
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('LIST_PENDING_SIGNATURES_FAILED', 'Sofia could not read signature status right now. Offer human follow-up.'));
  }
}
