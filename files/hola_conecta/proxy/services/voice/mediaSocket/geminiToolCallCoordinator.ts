import type { WebSocket } from 'ws';
import { logInfo } from '../../../utils/logger.js';
import { publishSofiaLiveCallState } from '../../phone/phoneLiveStateService.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent,
  sanitizePhoneJson
} from '../../phone/phoneJsonContract.ts';
import type { GeminiFunctionCall } from '../infobipMediaWebSocketGeminiFrames.ts';
import type { GeminiDomain } from '../infobipMediaWebSocketGeminiTypes.ts';
import { recordSofiaVoiceLiveDebugEvent } from '../sofiaVoiceLiveDebugStore.ts';
import { recordVokerVoiceToolCall } from '../sofiaVoiceObservabilityPayloadService.ts';
import { buildSofiaVoiceDebugJsonDump } from '../sofiaVoiceDeepDebugLog.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../sofiaVoiceJsonHandoffLogger.ts';
import type { GeminiToolResponseBody } from '../sofiaVoiceToolArgs.ts';
import { dispatchGeminiToolCall } from '../sofiaVoiceToolDispatcher.ts';
import type { VoiceSession } from '../voiceSessionTypes.ts';
import type { SofiaVoiceToolContextFactories } from './toolContextFactories.ts';

export type GeminiToolCallCoordinator = (call: GeminiFunctionCall) => void;

export function createGeminiToolCallCoordinator(input: {
  buildCurrentSessionHistory: (nextDomain: GeminiDomain, handoffSummary: string) => string;
  connectToGeminiDomain: (domain: GeminiDomain, sessionHistory: string) => void;
  emitLocalDebugEvent: (eventType: string, metadata: Record<string, unknown>) => void;
  getActiveGeminiDomain: () => GeminiDomain;
  getGeminiSocket: () => WebSocket | null;
  getSession: () => VoiceSession | null;
  logContext: string;
  productionTraceMetadata: () => Record<string, unknown>;
  pushLiveDebugEvent: (events: Record<string, unknown>[], event: Record<string, unknown>) => void;
  recentToolEvents: Record<string, unknown>[];
  requestEndCall: (reason: string, toolCallId: string | null) => void;
  sendGeminiToolResponse: (name: string, toolCallId: string | null, response: GeminiToolResponseBody) => void;
  setCurrentSessionHistory: (sessionHistory: string) => void;
  setRebindInProgress: (value: boolean) => void;
  toolContextFactories: SofiaVoiceToolContextFactories;
}): GeminiToolCallCoordinator {
  return (call) => {
    const activeGeminiDomain = input.getActiveGeminiDomain();
    const session = input.getSession();
    const liveSafeAction = call.name === 'prepare_user_transfer'
      ? 'transfer'
      : call.name === 'request_human_followup'
        ? 'handoff'
        : /booking|slot|appointment/i.test(call.name)
          ? 'booking'
          : /lookup|read|list|get/i.test(call.name)
            ? 'lookup'
            : 'none';
    const liveSofiaStatus = liveSafeAction === 'transfer'
      ? 'transferring'
      : liveSafeAction === 'booking'
        ? 'booking'
        : liveSafeAction === 'handoff'
          ? 'needs_human'
          : 'thinking';
    if (session) {
      void publishSofiaLiveCallState({
        session,
        sofiaStatus: liveSofiaStatus,
        currentSafeAction: liveSafeAction,
        lastSafeEventAt: new Date().toISOString(),
        projectionEventType: 'sofia_runtime_milestone',
      });
    }
    recordSofiaVoiceLiveDebugEvent({
      event: call.name === 'prepare_user_transfer' ? 'transfer_requested' : 'agent_response_last_received',
      callId: session?.callId || null,
      sessionId: session?.sessionId || null,
      orgId: session?.orgId || null,
      metadata: {
        activeGeminiDomain,
        toolCallId: call.id,
        toolName: call.name,
        argKeys: Object.keys(call.args).sort(),
        args: sanitizePhoneJson(call.args)
      }
    });
    if (session) {
      recordVokerVoiceToolCall({
        callId: session.callId,
        toolCallId: call.id,
        toolName: call.name,
        args: call.args
      });
    }
    input.pushLiveDebugEvent(input.recentToolEvents, {
      kind: 'tool_call',
      at: new Date().toISOString(),
      activeGeminiDomain,
      toolCallId: call.id,
      toolName: call.name,
      argKeys: Object.keys(call.args).sort(),
      args: sanitizePhoneJson(call.args)
    });
    logPhoneJsonEvent('voice.json.gemini.tool_call.received', buildPhoneJsonEnvelope({
      eventType: 'gemini.tool_call.received',
      orgId: session?.orgId || null,
      call: {
        provider_call_id: session?.callId || null,
        dialog_id: session?.dialogId || null,
        direction: 'inbound',
        status: 'answered'
      },
      actor: { type: 'sofia' },
      source: {
        sender: 'gemini_live',
        converter: 'infobipMediaWebSocketService.handleGeminiFunctionCall',
        receiver: 'sofiaVoiceToolDispatcher',
        transport: 'gemini_tool',
        provider_event_type: call.name,
        provider_payload_shape: 'internal'
      },
      metadata: {
        tool_call_id: call.id,
        tool_name: call.name,
        arg_keys: Object.keys(call.args).sort()
      }
    }));
    logJsonHandoff({
      logContext: input.logContext,
      event: 'voice.json.gemini.tool_call_received',
      sender: 'Gemini Live',
      converter: 'Sofia tool-call dispatcher',
      receiver: 'Sofia tool/MCP service',
      direction: 'sender_to_converter',
      stage: 'gemini_function_call_received',
      status: 'received',
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      orgId: session?.orgId || null,
      provider: 'gemini',
      payloadShape: buildJsonPayloadShape(call),
      metadata: {
        activeDomain: activeGeminiDomain,
        toolCallId: call.id,
        toolName: call.name,
        argKeys: Object.keys(call.args).sort()
      }
    });
    logInfo(input.logContext, 'voice.agent.tool_call.boundary_in', {
      ...input.productionTraceMetadata(),
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      activeDomain: activeGeminiDomain,
      toolCallDump: buildSofiaVoiceDebugJsonDump({
        label: 'gemini_function_call_to_dispatcher',
        value: call
      })
    });
    dispatchGeminiToolCall({
      activeGeminiDomain,
      ...input.toolContextFactories,
      buildCurrentSessionHistory: input.buildCurrentSessionHistory,
      connectToGeminiDomain: input.connectToGeminiDomain,
      emitLocalDebugEvent: input.emitLocalDebugEvent,
      gemini: input.getGeminiSocket(),
      logContext: input.logContext,
      requestEndCall: input.requestEndCall,
      sendGeminiToolResponse: input.sendGeminiToolResponse,
      session,
      setCurrentSessionHistory: input.setCurrentSessionHistory,
      setRebindInProgress: input.setRebindInProgress
    }, call);
  };
}
