import { logInfo } from '../../../../utils/logger.js';
import { buildSofiaVoiceDebugJsonDump } from '../../sofiaVoiceDeepDebugLog.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../../sofiaVoiceJsonHandoffLogger.ts';
import { recordReceptionistToolAttempt } from '../../sofiaReceptionistOutcome.ts';
import { sanitizeGeminiToolArgs } from '../../sofiaVoiceToolArgs.ts';
import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';

export function logReceivedGeminiToolCall(
  context: DispatchGeminiToolContext,
  call: GeminiToolCall
): void {
  const sanitizedArgs = sanitizeGeminiToolArgs(call.name, call.args);
  const session = context.session;
  if (!session) return;

  logJsonHandoff({
    logContext: context.logContext,
    event: 'voice.json.tool_call.sender_to_converter',
    sender: 'Gemini Live',
    converter: 'Sofia tool-call dispatcher',
    receiver: 'Sofia tool/MCP service',
    direction: 'sender_to_converter',
    stage: 'tool_call_received',
    status: 'received',
    sessionId: session.sessionId,
    callId: session.callId,
    orgId: session.orgId,
    provider: 'gemini',
    payloadShape: buildJsonPayloadShape(call),
    metadata: {
      toolCallId: call.id,
      toolName: call.name,
      activeDomain: context.activeGeminiDomain,
      argKeys: Object.keys(call.args).sort(),
      safeArgumentShape: sanitizedArgs
    }
  });
  logJsonHandoff({
    logContext: context.logContext,
    event: 'voice.json.tool_call.tool_input_converted',
    sender: 'Sofia tool-call dispatcher',
    converter: 'sanitizeGeminiToolArgs',
    receiver: 'Sofia tool/MCP service',
    direction: 'converter_to_receiver',
    stage: 'tool_input_converted',
    status: 'converted',
    sessionId: session.sessionId,
    callId: session.callId,
    orgId: session.orgId,
    provider: 'gemini',
    payloadShape: buildJsonPayloadShape(sanitizedArgs || {}),
    metadata: {
      toolCallId: call.id,
      toolName: call.name,
      activeDomain: context.activeGeminiDomain,
      argKeys: Object.keys(call.args).sort(),
      safeArgumentShape: sanitizedArgs
    }
  });
  recordReceptionistToolAttempt({
    session,
    toolName: call.name,
    domain: context.activeGeminiDomain
  });
  logInfo(context.logContext, 'voice.gemini.tool_call_received', {
    sessionId: session.sessionId,
    callId: session.callId,
    domain: context.activeGeminiDomain,
    toolCallId: call.id,
    toolName: call.name,
    argKeys: Object.keys(call.args).sort(),
    args: sanitizedArgs
  });
  logInfo(context.logContext, 'voice.tool_call.received', {
    sessionId: session.sessionId,
    callId: session.callId,
    activeDomain: context.activeGeminiDomain,
    toolCallId: call.id,
    toolName: call.name,
    argKeys: Object.keys(call.args).sort(),
    args: sanitizedArgs,
    requestShapeDump: buildSofiaVoiceDebugJsonDump({
      label: 'sofia_tool_call_received',
      value: call
    })
  });
  logInfo(context.logContext, 'voice.mcp.boundary.request', {
    sessionId: session.sessionId,
    callId: session.callId,
    activeDomain: context.activeGeminiDomain,
    toolCallId: call.id,
    toolName: call.name,
    requestDump: buildSofiaVoiceDebugJsonDump({
      label: 'sofia_internal_mcp_tool_request',
      value: {
        domain: context.activeGeminiDomain,
        toolName: call.name,
        args: call.args
      }
    })
  });
  context.emitLocalDebugEvent('tool_call_triggered', {
    toolCallId: call.id,
    toolName: call.name,
    argKeys: Object.keys(call.args).sort(),
    args: sanitizedArgs
  });
}
