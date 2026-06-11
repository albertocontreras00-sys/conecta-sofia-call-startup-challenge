import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import { handlePrepareUserTransferTool } from '../transfer/prepareUserTransfer.ts';
import type { RegisteredAsyncTool } from './registryTypes.ts';

export const TRANSFER_TOOL_REGISTRY: Record<string, RegisteredAsyncTool> = {
  prepare_user_transfer: {
    adkToolName: 'prepareUserTransfer',
    handler: 'transfer/prepareUserTransfer.handlePrepareUserTransferTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handlePrepareUserTransferTool(context.userTransferToolContext(), call.args, call.id)
  }
};
