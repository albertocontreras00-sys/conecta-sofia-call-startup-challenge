import { logInfo, logWarn } from '../../../../utils/logger.js';
import { runSophiaAdkToolBridgeDecision } from '../../../../sofia/adk/toolBridge.ts';
import type { SophiaAdkToolName } from '../../../../sofia/adk/types.ts';
import { buildSofiaVoiceDebugJsonDump } from '../../sofiaVoiceDeepDebugLog.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../../sofiaVoiceJsonHandoffLogger.ts';
import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';

export type AsyncToolHandler = () => Promise<void>;

export function logToolDispatch(context: DispatchGeminiToolContext, call: GeminiToolCall, handler: string): number {
  const startedAt = Date.now();
  logJsonHandoff({
    logContext: context.logContext,
    event: 'voice.json.tool_call.tool_dispatch_selected',
    sender: 'Sofia tool-call dispatcher',
    converter: 'Sofia tool dispatch router',
    receiver: handler,
    direction: 'converter_to_receiver',
    stage: 'tool_dispatch_selected',
    status: 'forwarded',
    sessionId: context.session?.sessionId || null,
    callId: context.session?.callId || null,
    orgId: context.session?.orgId || null,
    provider: 'gemini',
    payloadShape: buildJsonPayloadShape(call),
    metadata: {
      toolCallId: call.id,
      toolName: call.name,
      actionName: handler,
      activeDomain: context.activeGeminiDomain,
      argKeys: Object.keys(call.args).sort()
    }
  });
  logInfo(context.logContext, 'voice.tool_call.dispatching', {
    sessionId: context.session?.sessionId || null,
    callId: context.session?.callId || null,
    toolCallId: call.id,
    toolName: call.name,
    activeDomain: context.activeGeminiDomain,
    handler,
    argKeys: Object.keys(call.args).sort(),
    requestShapeDump: buildSofiaVoiceDebugJsonDump({
      label: 'sofia_tool_dispatch_request',
      value: call
    })
  });
  return startedAt;
}

export function runAsyncTool(
  context: DispatchGeminiToolContext,
  call: GeminiToolCall,
  handler: string,
  adkToolName: SophiaAdkToolName | null,
  run: AsyncToolHandler
): void {
  const startedAt = logToolDispatch(context, call, handler);
  if (adkToolName) {
    try {
      const adkDecision = runSophiaAdkToolBridgeDecision({
        sessionId: context.session?.sessionId || null,
        callId: context.session?.callId || null,
        orgId: context.session?.orgId || null,
        activeDomain: context.activeGeminiDomain,
        geminiToolName: call.name,
        geminiToolCallId: call.id,
        canonicalHandler: handler,
        canonicalTool: adkToolName,
        toolArgs: call.args
      });
      if (context.session) {
        context.session.sofiaAdk.toolBridgeDecisions.push({
          toolCallId: call.id,
          toolName: call.name,
          adkToolName,
          handler,
          agent: adkDecision.agent,
          decision: adkDecision.decision,
          shouldRunCanonicalHandler: adkDecision.shouldRunCanonicalHandler,
          trace: adkDecision.trace,
          at: new Date().toISOString()
        });
        context.session.sofiaAdk.toolBridgeDecisions = context.session.sofiaAdk.toolBridgeDecisions.slice(-50);
      }
      context.emitLocalDebugEvent('sophia_adk_tool_bridge_decision', {
        toolCallId: call.id,
        toolName: call.name,
        adkToolName,
        handler,
        decision: adkDecision
      });
      logJsonHandoff({
        logContext: context.logContext,
        event: 'voice.json.sophia_adk.tool_bridge_decision',
        sender: 'Gemini Live tool call',
        converter: 'Sophia ADK Orchestrator',
        receiver: handler,
        direction: 'converter_to_receiver',
        stage: 'sophia_adk_tool_bridge_decision',
        status: 'forwarded',
        sessionId: context.session?.sessionId || null,
        callId: context.session?.callId || null,
        orgId: context.session?.orgId || null,
        provider: 'google_adk',
        payloadShape: buildJsonPayloadShape(adkDecision),
        metadata: {
          toolCallId: call.id,
          toolName: call.name,
          adkToolName,
          activeDomain: context.activeGeminiDomain,
          handler,
          shouldRunCanonicalHandler: adkDecision.shouldRunCanonicalHandler,
          decisionDump: buildSofiaVoiceDebugJsonDump({
            label: 'sophia_adk_tool_bridge_decision',
            value: adkDecision
          })
        }
      });
      logInfo(context.logContext, 'voice.sophia_adk.tool_bridge.decision_created', {
        sessionId: context.session?.sessionId || null,
        callId: context.session?.callId || null,
        toolCallId: call.id,
        toolName: call.name,
        adkToolName,
        activeDomain: context.activeGeminiDomain,
        handler,
        shouldRunCanonicalHandler: adkDecision.shouldRunCanonicalHandler,
        decisionDump: buildSofiaVoiceDebugJsonDump({
          label: 'sophia_adk_tool_bridge_decision',
          value: adkDecision
        })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (context.session) {
        context.session.sofiaAdk.toolBridgeFailures.push({
          toolCallId: call.id,
          toolName: call.name,
          adkToolName,
          handler,
          errorMessage: message,
          at: new Date().toISOString()
        });
        context.session.sofiaAdk.toolBridgeFailures = context.session.sofiaAdk.toolBridgeFailures.slice(-50);
      }
      context.emitLocalDebugEvent('sophia_adk_tool_bridge_failed', {
        toolCallId: call.id,
        toolName: call.name,
        adkToolName,
        handler,
        errorMessage: message
      });
      logWarn(context.logContext, 'voice.sophia_adk.tool_bridge.failed_non_blocking', {
        sessionId: context.session?.sessionId || null,
        callId: context.session?.callId || null,
        toolCallId: call.id,
        toolName: call.name,
        adkToolName,
        activeDomain: context.activeGeminiDomain,
        handler,
        errorMessage: message,
        errorContextDump: buildSofiaVoiceDebugJsonDump({
          label: 'sophia_adk_tool_bridge_failure',
          value: {
            call,
            handler,
            adkToolName,
            error
          }
        })
      });
      logJsonHandoff({
        logContext: context.logContext,
        event: 'voice.json.sophia_adk.tool_bridge_failed',
        sender: 'Gemini Live tool call',
        converter: 'Sophia ADK Orchestrator',
        receiver: handler,
        direction: 'converter_to_receiver',
        stage: 'sophia_adk_tool_bridge_failed',
        status: 'failed',
        sessionId: context.session?.sessionId || null,
        callId: context.session?.callId || null,
        orgId: context.session?.orgId || null,
        provider: 'google_adk',
        reason: 'SOPHIA_ADK_TOOL_BRIDGE_FAILED_NON_BLOCKING',
        metadata: {
          toolCallId: call.id,
          toolName: call.name,
          adkToolName,
          activeDomain: context.activeGeminiDomain,
          handler,
          errorMessage: message,
          errorDump: buildSofiaVoiceDebugJsonDump({
            label: 'sophia_adk_tool_bridge_failure',
            value: {
              call,
              handler,
              adkToolName,
              error
            }
          })
        }
      });
    }
  }
  logJsonHandoff({
    logContext: context.logContext,
    event: 'voice.json.mcp.tool_receiver_invoked',
    sender: 'Sofia tool-call dispatcher',
    converter: handler,
    receiver: 'Sofia tool/MCP service',
    direction: 'converter_to_receiver',
    stage: 'tool_receiver_invoked',
    status: 'started',
    sessionId: context.session?.sessionId || null,
    callId: context.session?.callId || null,
    orgId: context.session?.orgId || null,
    provider: 'gemini',
    payloadShape: buildJsonPayloadShape(call.args),
    metadata: {
      toolCallId: call.id,
      toolName: call.name,
      actionName: handler,
      activeDomain: context.activeGeminiDomain,
      argKeys: Object.keys(call.args).sort()
    }
  });
  void run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    context.sendGeminiToolResponse(call.name, call.id, {
      ok: false,
      errorCode: 'TOOL_HANDLER_FAILED',
      message: `Sofia tool ${call.name} failed: ${message}`
    });
    logWarn(context.logContext, 'voice.tool_call.error_sent', {
      sessionId: context.session?.sessionId || null,
      callId: context.session?.callId || null,
      toolCallId: call.id,
      toolName: call.name,
      activeDomain: context.activeGeminiDomain,
      handler,
      durationMs: Date.now() - startedAt,
      errorCode: 'TOOL_HANDLER_FAILED',
      errorMessage: message,
      errorContextDump: buildSofiaVoiceDebugJsonDump({
        label: 'sofia_tool_handler_uncaught_error',
        value: {
          call,
          handler,
          error
        }
      })
    });
    logJsonHandoff({
      logContext: context.logContext,
      event: 'voice.json.mcp.tool_receiver_failed',
      sender: 'Sofia tool/MCP service',
      converter: handler,
      receiver: 'Sofia tool response adapter',
      direction: 'receiver_response',
      stage: 'tool_receiver_failed',
      status: 'failed',
      sessionId: context.session?.sessionId || null,
      callId: context.session?.callId || null,
      orgId: context.session?.orgId || null,
      provider: 'gemini',
      durationMs: Date.now() - startedAt,
      reason: 'TOOL_HANDLER_FAILED',
      metadata: {
        toolCallId: call.id,
        toolName: call.name,
        actionName: handler,
        activeDomain: context.activeGeminiDomain,
        errorCode: 'TOOL_HANDLER_FAILED'
      }
    });
  });
}
