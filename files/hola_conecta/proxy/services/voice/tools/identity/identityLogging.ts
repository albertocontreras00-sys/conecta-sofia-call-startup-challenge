import { logInfo } from '../../../../utils/logger.js';
import { buildSofiaVoiceDebugJsonDump } from '../../sofiaVoiceDeepDebugLog.ts';
import type { SofiaIdentityCrmVoiceToolContext } from './types.ts';

export function logIdentityBoundary(
  context: SofiaIdentityCrmVoiceToolContext,
  event: string,
  toolName: string,
  toolCallId: string | null,
  value: Record<string, unknown>
): void {
  logInfo(context.logContext, event, {
    sessionId: context.session?.sessionId || null,
    callId: context.session?.callId || null,
    orgId: context.session?.orgId || null,
    activeDomain: context.activeGeminiDomain,
    toolCallId,
    toolName,
    dump: buildSofiaVoiceDebugJsonDump({
      label: `${toolName}_${event}`,
      value
    })
  });
}
