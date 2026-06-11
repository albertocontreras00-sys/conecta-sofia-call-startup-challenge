import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import { BOOKING_TOOL_REGISTRY } from './bookingRegistry.ts';
import { IDENTITY_TOOL_REGISTRY } from './identityRegistry.ts';
import { OWNER_DEBUG_TOOL_REGISTRY } from './ownerDebugRegistry.ts';
import { RECEPTIONIST_TOOL_REGISTRY } from './receptionistRegistry.ts';
import type { RegisteredAsyncTool } from './registryTypes.ts';
import { TRANSFER_TOOL_REGISTRY } from './transferRegistry.ts';
import { runAsyncTool } from './toolRunner.ts';

const ASYNC_TOOL_REGISTRY: Record<string, RegisteredAsyncTool> = {
  ...BOOKING_TOOL_REGISTRY,
  ...IDENTITY_TOOL_REGISTRY,
  ...RECEPTIONIST_TOOL_REGISTRY,
  ...TRANSFER_TOOL_REGISTRY,
  ...OWNER_DEBUG_TOOL_REGISTRY
};

export function dispatchRegisteredAsyncTool(context: DispatchGeminiToolContext, call: GeminiToolCall): boolean {
  const registeredTool = ASYNC_TOOL_REGISTRY[call.name];
  if (!registeredTool) return false;
  const adkToolName = registeredTool.resolveAdkToolName?.(call) ?? registeredTool.adkToolName ?? null;
  runAsyncTool(context, call, registeredTool.handler, adkToolName, () => registeredTool.run(context, call));
  return true;
}
