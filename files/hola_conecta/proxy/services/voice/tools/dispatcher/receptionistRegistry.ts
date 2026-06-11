import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import type { SophiaAdkToolName } from '../../../../sofia/adk/types.ts';
import { handleLookupBusinessInfoTool } from '../receptionist/businessInfo.ts';
import { handleCreateCallbackTaskTool } from '../receptionist/callbackTask.ts';
import { handleListCallerDocumentsTool } from '../receptionist/documents.ts';
import { handleRequestHumanFollowupTool } from '../receptionist/humanFollowup.ts';
import { handleSendSmsTool } from '../receptionist/sendSms.ts';
import { handleListPendingSignaturesTool } from '../receptionist/signatures.ts';
import type { RegisteredAsyncTool } from './registryTypes.ts';

function businessInfoAdkToolName(call: GeminiToolCall): SophiaAdkToolName {
  const questionType = typeof call.args.questionType === 'string' ? call.args.questionType : '';
  return questionType === 'office_address'
    || questionType === 'directions'
    || questionType === 'parking'
    || questionType === 'nearby_landmark'
    || questionType === 'map_link_request'
    ? 'GoogleMapsGroundingTool'
    : 'getBusinessKnowledge';
}

export const RECEPTIONIST_TOOL_REGISTRY: Record<string, RegisteredAsyncTool> = {
  list_caller_documents: {
    adkToolName: 'getDocumentStatus',
    handler: 'receptionist/documents.handleListCallerDocumentsTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleListCallerDocumentsTool(context.receptionistToolContext(), call.args, call.id)
  },
  list_pending_signatures: {
    adkToolName: 'getSignatureStatus',
    handler: 'receptionist/signatures.handleListPendingSignaturesTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleListPendingSignaturesTool(context.receptionistToolContext(), call.args, call.id)
  },
  lookup_business_info: {
    adkToolName: 'getBusinessKnowledge',
    resolveAdkToolName: businessInfoAdkToolName,
    handler: 'receptionist/businessInfo.handleLookupBusinessInfoTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleLookupBusinessInfoTool(context.receptionistToolContext(), call.args, call.id)
  },
  create_callback_task: {
    adkToolName: 'createCallbackFollowUp',
    handler: 'receptionist/callbackTask.handleCreateCallbackTaskTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleCreateCallbackTaskTool(context.receptionistToolContext(), call.args, call.id)
  },
  send_sms: {
    handler: 'receptionist/sendSms.handleSendSmsTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleSendSmsTool(context.receptionistToolContext(), call.args, call.id)
  },
  request_human_followup: {
    adkToolName: 'createCallbackFollowUp',
    handler: 'receptionist/humanFollowup.handleRequestHumanFollowupTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleRequestHumanFollowupTool(context.receptionistToolContext(), call.args, call.id)
  }
};
