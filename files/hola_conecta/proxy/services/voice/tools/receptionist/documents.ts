import { logError } from '../../../../utils/logger.js';
import * as aiReadService from '../../../aiReadService.ts';
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

function isReceivedDocumentStatus(status: string | null): boolean {
  return status === 'uploaded'
    || status === 'received'
    || status === 'accepted'
    || status === 'completed';
}

function isMissingDocumentStatus(status: string | null): boolean {
  return status === 'requested'
    || status === 'draft'
    || status === 'missing'
    || status === 'pending'
    || status === null;
}

function displayDocumentName(record: RuntimeRecord): string {
  return textValue(record.title)
    || textValue(record.name)
    || textValue(record.document_name)
    || textValue(record.file_name)
    || textValue(record.request_title)
    || 'Document request';
}

function summarizeDocument(record: RuntimeRecord): RuntimeRecord {
  const status = statusValue(record.status) || statusValue(record.request_status) || statusValue(record.upload_status) || null;
  const receivedAt = textValue(record.received_at) || textValue(record.uploaded_at) || textValue(record.completed_at);
  return {
    id: textValue(record.id),
    name: displayDocumentName(record),
    status,
    receivedAt,
    requestedAt: textValue(record.requested_at) || textValue(record.created_at),
    dueAt: textValue(record.due_at) || textValue(record.due_date),
    missing: record.is_missing === true || (!receivedAt && isMissingDocumentStatus(status))
  };
}

export function summarizeDocumentProgress(summaries: RuntimeRecord[]): RuntimeRecord {
  const receivedDocuments = summaries.filter((document) => {
    const status = statusValue(document.status);
    return Boolean(textValue(document.receivedAt)) || isReceivedDocumentStatus(status);
  });
  const missingDocuments = summaries.filter((document) => {
    if (document.missing === true) return true;
    const status = statusValue(document.status);
    return !textValue(document.receivedAt) && isMissingDocumentStatus(status);
  });
  return {
    totalRequested: summaries.length,
    receivedCount: receivedDocuments.length,
    missingCount: missingDocuments.length,
    missingDocumentNames: missingDocuments
      .map((document) => textValue(document.name))
      .filter((name): name is string => Boolean(name))
      .slice(0, 5)
  };
}

export async function handleListCallerDocumentsTool(
  context: SofiaReceptionistVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'list_caller_documents';
  logReceptionistBoundary(context, 'voice.mcp.documents.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireDomain(context, ['documents', 'orchestrator'], toolName, toolCallId)) return;
  const identity = requireSessionAndContact(context, toolName, toolCallId);
  if (!identity) return;
  const limit = Math.min(Math.max(integerArg(args, 'limit') || 5, 1), 10);
  try {
    const documents = await aiReadService.getDocuments({
      orgId: identity.session.orgId,
      contactId: identity.contactId,
      limit
    });
    const summaries = documents.map((document) => summarizeDocument(asRecord(document)));
    const progress = summarizeDocumentProgress(summaries);
    logReceptionistBoundary(context, 'voice.mcp.documents.response_shape', toolName, toolCallId, {
      documents,
      summaries,
      progress,
      documentCount: summaries.length
    });
    context.sendGeminiToolResponse(toolName, toolCallId, {
      ok: true,
      documents: summaries,
      documentCount: summaries.length,
      documentProgress: progress,
      totalRequestedDocuments: progress.totalRequested,
      receivedDocumentCount: progress.receivedCount,
      missingDocumentCount: progress.missingCount,
      missingDocumentNames: progress.missingDocumentNames,
      sensitiveDetailsRequirePin: true,
      message: summaries.length
        ? 'Speak only the returned document status summaries and documentProgress counts. Do not mention file contents or links.'
        : 'No document requests were found for the matched caller.'
    });
  } catch (error) {
    logError(context.logContext, 'voice.gemini.list_caller_documents_failed', error, {
      orgId: identity.session.orgId,
      contactId: identity.contactId,
      sessionId: identity.session.sessionId,
      callId: identity.session.callId
    });
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('LIST_CALLER_DOCUMENTS_FAILED', 'Sofia could not read document status right now. Offer human follow-up.'));
  }
}
