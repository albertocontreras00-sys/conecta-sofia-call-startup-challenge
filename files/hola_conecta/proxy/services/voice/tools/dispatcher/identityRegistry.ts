import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import { handleCommitContactFieldUpdateTool, handlePrepareContactFieldUpdateTool } from '../identity/contactUpdates.ts';
import { handleLookupBusinessContextTool, handleLookupHouseholdContextTool } from '../identity/contexts.ts';
import { handleCommitContactNoteOrTaskTool, handlePrepareContactNoteOrTaskTool } from '../identity/notesTasks.ts';
import {
  handleListAvailableContactFieldsTool,
  handleLookupCallerProfileTool,
  handleReadCallerContactFieldsTool,
  handleVerifyCallerPinTool
} from '../identity/profile.ts';
import type { RegisteredAsyncTool } from './registryTypes.ts';

export const IDENTITY_TOOL_REGISTRY: Record<string, RegisteredAsyncTool> = {
  lookup_caller_profile: {
    adkToolName: 'verifyCallerIdentity',
    handler: 'identity/profile.handleLookupCallerProfileTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleLookupCallerProfileTool(context.identityCrmToolContext(), call.args, call.id)
  },
  verify_caller_pin: {
    adkToolName: 'verifyCallerIdentity',
    handler: 'identity/profile.handleVerifyCallerPinTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleVerifyCallerPinTool(context.identityCrmToolContext(), call.args, call.id)
  },
  read_caller_contact_fields: {
    adkToolName: 'verifyCallerIdentity',
    handler: 'identity/profile.handleReadCallerContactFieldsTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleReadCallerContactFieldsTool(context.identityCrmToolContext(), call.args, call.id)
  },
  prepare_contact_field_update: {
    adkToolName: 'updateContactTimeline',
    handler: 'identity/contactUpdates.handlePrepareContactFieldUpdateTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handlePrepareContactFieldUpdateTool(context.identityCrmToolContext(), call.args, call.id)
  },
  commit_contact_field_update: {
    adkToolName: 'updateContactTimeline',
    handler: 'identity/contactUpdates.handleCommitContactFieldUpdateTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleCommitContactFieldUpdateTool(context.identityCrmToolContext(), call.args, call.id)
  },
  list_available_contact_fields: {
    adkToolName: 'verifyCallerIdentity',
    handler: 'identity/profile.handleListAvailableContactFieldsTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleListAvailableContactFieldsTool(context.identityCrmToolContext(), call.args, call.id)
  },
  lookup_household_context: {
    adkToolName: 'verifyCallerIdentity',
    handler: 'identity/contexts.handleLookupHouseholdContextTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleLookupHouseholdContextTool(context.identityCrmToolContext(), call.args, call.id)
  },
  lookup_business_context: {
    adkToolName: 'verifyCallerIdentity',
    handler: 'identity/contexts.handleLookupBusinessContextTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleLookupBusinessContextTool(context.identityCrmToolContext(), call.args, call.id)
  },
  prepare_contact_note_or_task: {
    adkToolName: 'updateContactTimeline',
    handler: 'identity/notesTasks.handlePrepareContactNoteOrTaskTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handlePrepareContactNoteOrTaskTool(context.identityCrmToolContext(), call.args, call.id)
  },
  commit_contact_note_or_task: {
    adkToolName: 'updateContactTimeline',
    handler: 'identity/notesTasks.handleCommitContactNoteOrTaskTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleCommitContactNoteOrTaskTool(context.identityCrmToolContext(), call.args, call.id)
  }
};
