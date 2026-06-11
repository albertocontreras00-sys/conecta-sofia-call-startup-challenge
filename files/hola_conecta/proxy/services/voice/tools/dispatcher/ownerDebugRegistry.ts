import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import { handleLookupSofiaDebugCodeContextTool } from '../debug/codeContext.ts';
import { handleGetCurrentCallDebugContextTool } from '../debug/currentCallContext.ts';
import { handleReportSofiaDebugObservationTool } from '../debug/reportObservation.ts';
import type { RegisteredAsyncTool } from './registryTypes.ts';

export const OWNER_DEBUG_TOOL_REGISTRY: Record<string, RegisteredAsyncTool> = {
  report_sofia_debug_observation: {
    handler: 'debug/reportObservation.handleReportSofiaDebugObservationTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleReportSofiaDebugObservationTool(context.ownerDebugToolContext(), call.args, call.id)
  },
  lookup_sofia_debug_code_context: {
    handler: 'debug/codeContext.handleLookupSofiaDebugCodeContextTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleLookupSofiaDebugCodeContextTool(context.ownerDebugToolContext(), call.args, call.id)
  },
  get_current_call_debug_context: {
    handler: 'debug/currentCallContext.handleGetCurrentCallDebugContextTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleGetCurrentCallDebugContextTool(context.ownerDebugToolContext(), call.args, call.id)
  }
};
