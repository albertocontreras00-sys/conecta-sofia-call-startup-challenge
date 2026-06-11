import { WebSocket } from 'ws';
import { logInfo, logWarn } from '../../../../utils/logger.js';
import { isSwitchableGeminiDomain, normalizeGeminiDomain } from '../../infobipMediaWebSocketGemini.ts';
import { buildSofiaVoiceDebugJsonDump } from '../../sofiaVoiceDeepDebugLog.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import { logToolDispatch } from './toolRunner.ts';

export function dispatchControlTool(context: DispatchGeminiToolContext, call: GeminiToolCall): boolean {
  if (call.name === 'switchDomain') {
    dispatchSwitchDomainTool(context, call);
    return true;
  }
  if (call.name === 'end_call') {
    dispatchEndCallTool(context, call);
    return true;
  }
  return false;
}

function dispatchSwitchDomainTool(context: DispatchGeminiToolContext, call: GeminiToolCall): void {
  const session = context.session;
  const gemini = context.gemini;
  if (!session || !gemini) return;
  logToolDispatch(context, call, 'sofiaVoiceToolDispatcher.switchDomain');
  const rawDomain = typeof call.args.domain === 'string' ? call.args.domain.trim().toLowerCase() : '';
  if (!isSwitchableGeminiDomain(rawDomain)) {
    context.sendGeminiToolResponse('switchDomain', call.id, {
      ok: false,
      errorCode: 'INVALID_DOMAIN',
      message: 'switchDomain requires domain to be one of identity, appointments, profile, documents, signatures, tasks, or handoff.'
    });
    context.emitLocalDebugEvent('tool_response_sent', {
      toolCallId: call.id,
      toolName: call.name,
      ok: false,
      errorCode: 'INVALID_DOMAIN'
    });
    logWarn(context.logContext, 'voice.gemini.tool_switch_domain_rejected', {
      sessionId: session.sessionId,
      callId: session.callId,
      domain: rawDomain || null,
      reason: 'invalid_domain'
    });
    logWarn(context.logContext, 'voice.tool_call.domain_mismatch', {
      sessionId: session.sessionId,
      callId: session.callId,
      toolCallId: call.id,
      toolName: call.name,
      activeDomain: context.activeGeminiDomain,
      targetDomain: rawDomain || null,
      errorCode: 'INVALID_DOMAIN',
      mismatchDump: buildSofiaVoiceDebugJsonDump({
        label: 'switch_domain_invalid_domain',
        value: {
          rawDomain,
          args: call.args,
          activeDomain: context.activeGeminiDomain
        }
      })
    });
    return;
  }
  const domain = normalizeGeminiDomain(rawDomain);
  const handoffSummary = typeof call.args.summary === 'string' ? call.args.summary.trim() : '';
  if (!handoffSummary) {
    context.sendGeminiToolResponse('switchDomain', call.id, {
      ok: false,
      errorCode: 'MISSING_REQUIRED_SUMMARY',
      message: 'switchDomain requires a non-empty summary argument for silent rebind context.'
    });
    context.emitLocalDebugEvent('tool_response_sent', {
      toolCallId: call.id,
      toolName: call.name,
      ok: false,
      errorCode: 'MISSING_REQUIRED_SUMMARY'
    });
    logWarn(context.logContext, 'voice.gemini.tool_switch_domain_rejected', {
      sessionId: session.sessionId,
      callId: session.callId,
      domain,
      reason: 'missing_summary',
      rejectionDump: buildSofiaVoiceDebugJsonDump({
        label: 'switch_domain_missing_summary',
        value: call
      })
    });
    return;
  }
  const previousGemini = gemini;
  const previousDomain = context.activeGeminiDomain;
  const currentSessionHistory = context.buildCurrentSessionHistory(domain, handoffSummary);
  context.setCurrentSessionHistory(currentSessionHistory);
  context.setRebindInProgress(true);
  context.sendGeminiToolResponse('switchDomain', call.id, {
    ok: true,
    domain,
    message: `Switching Sofia to the ${domain} domain.`
  });
  logInfo(context.logContext, 'voice.gemini.tool_switch_domain', {
    sessionId: session.sessionId,
    callId: session.callId,
    toolCallId: call.id,
    fromDomain: previousDomain,
    toDomain: domain,
    action: 'silent_rebind'
  });
  logInfo(context.logContext, 'voice.domain.switch_requested', {
    sessionId: session.sessionId,
    callId: session.callId,
    toolCallId: call.id,
    fromDomain: previousDomain,
    toDomain: domain
  });
  context.connectToGeminiDomain(domain, currentSessionHistory);
  logInfo(context.logContext, 'voice.domain.switch_completed', {
    sessionId: session.sessionId,
    callId: session.callId,
    toolCallId: call.id,
    fromDomain: previousDomain,
    toDomain: domain
  });
  context.emitLocalDebugEvent('domain_rebind_started', {
    fromDomain: previousDomain,
    toDomain: domain
  });
  if (previousGemini.readyState === WebSocket.OPEN) {
    previousGemini.close(1000, `switch_domain_${domain}`);
  } else if (previousGemini.readyState === WebSocket.CONNECTING) {
    previousGemini.close(1000, `switch_domain_${domain}`);
  }
}

function dispatchEndCallTool(context: DispatchGeminiToolContext, call: GeminiToolCall): void {
  logToolDispatch(context, call, 'sofiaVoiceToolDispatcher.end_call');
  const reason = stringArg(call.args, 'reason') || 'caller_done';
  context.sendGeminiToolResponse('end_call', call.id, {
    ok: true,
    shouldEndCall: true,
    message: 'Sofia should say one short closing now. The bridge will close the call after the final audio is sent.'
  });
  context.requestEndCall(reason, call.id);
}
