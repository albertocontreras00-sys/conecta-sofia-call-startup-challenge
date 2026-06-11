import { WebSocket } from 'ws';
import { logInfo } from '../../../utils/logger.js';
import { publishSofiaLiveCallState } from '../../phone/phoneLiveStateService.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent,
  sanitizePhoneJson
} from '../../phone/phoneJsonContract.ts';
import { recordSofiaVoiceLiveDebugEvent } from '../sofiaVoiceLiveDebugStore.ts';
import { recordReceptionistToolResponse } from '../sofiaReceptionistOutcome.ts';
import { recordVokerVoiceToolResult } from '../sofiaVoiceObservabilityPayloadService.ts';
import { buildSofiaVoiceDebugJsonDump } from '../sofiaVoiceDeepDebugLog.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../sofiaVoiceJsonHandoffLogger.ts';
import { languageInstruction, type SofiaVoiceResponseLanguage } from '../sofiaVoiceLanguage.ts';
import { summarizeGeminiToolResponse, type GeminiToolResponseBody } from '../sofiaVoiceToolArgs.ts';
import type { GeminiDomain } from '../infobipMediaWebSocketGeminiTypes.ts';
import type { VoiceSession } from '../voiceSessionTypes.ts';

export type GeminiToolResponseSender = (
  name: string,
  toolCallId: string | null,
  response: GeminiToolResponseBody
) => void;

export function createGeminiToolResponseSender(input: {
  emitLocalDebugEvent: (eventType: string, metadata: Record<string, unknown>) => void;
  getActiveGeminiDomain: () => GeminiDomain;
  getGeminiSocket: () => WebSocket | null;
  getResponseLanguage: () => SofiaVoiceResponseLanguage;
  getSession: () => VoiceSession | null;
  logContext: string;
  productionTraceMetadata: () => Record<string, unknown>;
  pushLiveDebugEvent: (events: Record<string, unknown>[], event: Record<string, unknown>) => void;
  recentToolEvents: Record<string, unknown>[];
  scheduleToolResponseAudioWatchdog: (toolName: string, responseSummary: Record<string, unknown>) => void;
}): GeminiToolResponseSender {
  return (name, toolCallId, response) => {
    const gemini = input.getGeminiSocket();
    if (!gemini || gemini.readyState !== WebSocket.OPEN) return;
    const responseLanguage = input.getResponseLanguage();
    const responseWithLanguage = {
      ...response,
      responseLanguage,
      languageInstruction: languageInstruction(responseLanguage)
    } as GeminiToolResponseBody;
    const session = input.getSession();
    const activeDomain = input.getActiveGeminiDomain();
    if (session) {
      recordVokerVoiceToolResult({
        callId: session.callId,
        toolCallId,
        toolName: name,
        response: responseWithLanguage
      });
    }
    const responseSummary = {
      ...summarizeGeminiToolResponse(name, responseWithLanguage),
      responseLanguage
    };
    if (session) {
      void publishSofiaLiveCallState({
        session,
        sofiaStatus: responseWithLanguage.ok === false ? 'error' : name === 'prepare_user_transfer' ? 'transferring' : 'speaking',
        currentSafeAction: name === 'prepare_user_transfer'
          ? 'transfer'
          : name === 'request_human_followup'
            ? 'handoff'
            : /booking|slot|appointment/i.test(name)
              ? 'booking'
              : /lookup|read|list|get/i.test(name)
                ? 'lookup'
                : 'none',
        lastSafeEventAt: new Date().toISOString(),
        projectionEventType: 'sofia_runtime_milestone',
      });
    }
    input.pushLiveDebugEvent(input.recentToolEvents, {
      kind: 'tool_response',
      at: new Date().toISOString(),
      activeGeminiDomain: activeDomain,
      toolCallId,
      toolName: name,
      ok: responseWithLanguage.ok !== false,
      errorCode: responseWithLanguage.ok === false && typeof responseWithLanguage.errorCode === 'string' ? responseWithLanguage.errorCode : null,
      responseSummary: sanitizePhoneJson(responseSummary)
    });
    recordSofiaVoiceLiveDebugEvent({
      event: name === 'prepare_user_transfer' ? 'transfer_call_control_started' : 'agent_response_last_received',
      callId: session?.callId || null,
      sessionId: session?.sessionId || null,
      orgId: session?.orgId || null,
      metadata: {
        activeGeminiDomain: activeDomain,
        toolCallId,
        toolName: name,
        ok: responseWithLanguage.ok !== false,
        errorCode: responseWithLanguage.ok === false && typeof responseWithLanguage.errorCode === 'string' ? responseWithLanguage.errorCode : null,
        responseSummary: sanitizePhoneJson(responseSummary)
      }
    });
    logJsonHandoff({
      logContext: input.logContext,
      event: 'voice.json.tool_call.tool_response_converted',
      sender: 'Sofia tool/MCP service',
      converter: 'Sofia tool response adapter',
      receiver: 'Gemini Live',
      direction: 'converter_to_receiver',
      stage: 'tool_response_converted',
      status: responseWithLanguage.ok === false ? 'failed' : 'converted',
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      orgId: session?.orgId || null,
      provider: 'gemini',
      payloadShape: buildJsonPayloadShape(responseSummary),
      metadata: {
        activeDomain,
        toolCallId,
        toolName: name,
        success: responseWithLanguage.ok !== false,
        safeResponseSummary: responseSummary
      }
    });
    recordReceptionistToolResponse({
      session,
      toolName: name,
      domain: activeDomain,
      response: responseWithLanguage
    });
    const liveApiResponsePayload = responseWithLanguage.ok === false
      ? { error: responseWithLanguage }
      : { result: responseWithLanguage };
    const toolResponsePayload = {
      toolResponse: {
        functionResponses: [{
          ...(toolCallId ? { id: toolCallId } : {}),
          name,
          response: liveApiResponsePayload
        }]
      }
    };
    logInfo(input.logContext, 'voice.gemini.tool_response.shape_dump', {
      ...input.productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      activeDomain,
      toolCallId,
      toolName: name,
      toolResponseDump: buildSofiaVoiceDebugJsonDump({
        label: 'gemini_live_tool_response_payload',
        value: toolResponsePayload
      })
    });
    logJsonHandoff({
      logContext: input.logContext,
      event: 'voice.json.gemini.tool_response_sent',
      sender: 'Sofia tool/MCP service',
      converter: 'Sofia tool response adapter',
      receiver: 'Gemini Live',
      direction: 'sender_to_receiver',
      stage: 'tool_response_payload',
      status: responseWithLanguage.ok === false ? 'failed' : 'sent',
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      orgId: session?.orgId || null,
      provider: 'gemini',
      payloadShape: buildJsonPayloadShape(toolResponsePayload),
      metadata: {
        activeDomain,
        toolCallId,
        toolName: name,
        success: responseWithLanguage.ok !== false,
        errorCode: responseWithLanguage.ok === false && typeof responseWithLanguage.errorCode === 'string' ? responseWithLanguage.errorCode : null
      }
    });
    logPhoneJsonEvent('voice.json.gemini.tool_response.sent', buildPhoneJsonEnvelope({
      eventType: 'gemini.tool_response.sent',
      orgId: session?.orgId || null,
      call: {
        provider_call_id: session?.callId || null,
        dialog_id: session?.dialogId || null,
        direction: 'inbound',
        status: responseWithLanguage.ok === false ? 'failed' : 'answered'
      },
      actor: { type: 'sofia' },
      source: {
        sender: 'sofia_tool_response_adapter',
        converter: 'infobipMediaWebSocketService.sendGeminiToolResponse',
        receiver: 'gemini_live',
        transport: 'gemini_tool',
        provider_event_type: name,
        provider_payload_shape: 'internal'
      },
      metadata: {
        tool_call_id: toolCallId,
        tool_name: name,
        success: responseWithLanguage.ok !== false,
        error_code: responseWithLanguage.ok === false && typeof responseWithLanguage.errorCode === 'string' ? responseWithLanguage.errorCode : null
      }
    }));
    logInfo(input.logContext, 'voice.agent.tool_call.boundary_out', {
      ...input.productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      activeDomain,
      toolCallId,
      toolName: name,
      responseDump: buildSofiaVoiceDebugJsonDump({
        label: 'sofia_tool_response_body',
        value: responseWithLanguage
      })
    });
    logInfo(input.logContext, 'voice.mcp.boundary.response', {
      ...input.productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      activeDomain,
      toolCallId,
      toolName: name,
      responseDump: buildSofiaVoiceDebugJsonDump({
        label: 'sofia_internal_mcp_tool_response',
        value: {
          domain: activeDomain,
          toolName: name,
          response: responseWithLanguage
        }
      })
    });
    gemini.send(JSON.stringify(toolResponsePayload));
    logInfo(input.logContext, responseWithLanguage.ok === false ? 'voice.tool_call.error_sent' : 'voice.tool_call.result_sent', {
      ...input.productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      activeDomain,
      toolCallId,
      toolName: name,
      success: responseWithLanguage.ok !== false,
      errorCode: responseWithLanguage.ok === false && typeof responseWithLanguage.errorCode === 'string' ? responseWithLanguage.errorCode : null
    });
    logInfo(input.logContext, 'voice.gemini.tool_response.sent', {
      ...input.productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      activeDomain,
      toolCallId,
      toolName: name,
      success: responseWithLanguage.ok !== false
    });
    input.emitLocalDebugEvent('tool_response_sent', {
      toolCallId,
      toolName: name,
      ...responseSummary
    });
    logInfo(input.logContext, 'voice.gemini.tool_response_sent', {
      ...input.productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      domain: activeDomain,
      toolCallId,
      toolName: name,
      ...responseSummary
    });
    input.scheduleToolResponseAudioWatchdog(name, responseSummary);
  };
}
