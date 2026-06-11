import { logWarn } from '../../../../utils/logger.js';
import { buildSofiaVoiceDebugJsonDump } from '../../sofiaVoiceDeepDebugLog.ts';
import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';

export function sendUnhandledToolResponse(context: DispatchGeminiToolContext, call: GeminiToolCall): void {
  const session = context.session;
  if (!session) return;
  context.sendGeminiToolResponse(call.name, call.id, {
    ok: false,
    errorCode: 'TOOL_NOT_REGISTERED',
    message: `Tool ${call.name} is not registered in the current Live API bridge phase.`
  });
  logWarn(context.logContext, 'voice.tool_call.unhandled', {
    sessionId: session.sessionId,
    callId: session.callId,
    domain: context.activeGeminiDomain,
    toolCallId: call.id,
    toolName: call.name,
    unhandledDump: buildSofiaVoiceDebugJsonDump({
      label: 'unhandled_sofia_tool_call',
      value: call
    })
  });
  context.emitLocalDebugEvent('tool_response_sent', {
    toolCallId: call.id,
    toolName: call.name,
    ok: false,
    errorCode: 'TOOL_NOT_REGISTERED'
  });
  logWarn(context.logContext, 'voice.gemini.tool_response_sent', {
    sessionId: session.sessionId,
    callId: session.callId,
    domain: context.activeGeminiDomain,
    toolCallId: call.id,
    toolName: call.name,
    ok: false,
    errorCode: 'TOOL_NOT_REGISTERED'
  });
}
