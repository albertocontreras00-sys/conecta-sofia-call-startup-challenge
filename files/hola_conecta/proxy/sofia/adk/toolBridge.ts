import type {
  SophiaAdkAgentName,
  SophiaAdkToolExecutionInput,
  SophiaAdkToolExecutionOutput,
  SophiaAdkToolName,
  SophiaAdkTraceEntry
} from './types.ts';
import { findSophiaAdkTool } from './tools.ts';

function agentForTool(tool: SophiaAdkToolName): SophiaAdkAgentName {
  switch (tool) {
    case 'getSofiaSettings':
    case 'getBusinessKnowledge':
    case 'GoogleMapsGroundingTool':
      return 'OfficeKnowledgeAgent';
    case 'verifyCallerIdentity':
    case 'getDocumentStatus':
    case 'getSignatureStatus':
      return 'ComplianceSafetyAgent';
    case 'lookupAppointmentAvailability':
    case 'lookupUpcomingBookings':
    case 'createBooking':
    case 'cancelBooking':
    case 'rescheduleBooking':
    case 'prepareUserTransfer':
    case 'fallbackToExternalPhone':
    case 'transferToVoicemail':
      return 'RoutingEscalationAgent';
    case 'createCallbackFollowUp':
    case 'saveCallSummary':
    case 'updateContactTimeline':
      return 'FollowUpActionAgent';
  }
}

function buildTrace(input: SophiaAdkToolExecutionInput, agent: SophiaAdkAgentName): SophiaAdkTraceEntry[] {
  const canonicalTool = findSophiaAdkTool(input.canonicalTool);
  return [
    {
      agent: 'SophiaOrchestratorAgent',
      decision: `Routed Gemini Live tool ${input.geminiToolName} to ${input.canonicalTool}.`,
      inputs: {
        geminiToolName: input.geminiToolName,
        canonicalTool: input.canonicalTool,
        activeDomain: input.activeDomain,
        argKeys: Object.keys(input.toolArgs).sort()
      },
      outputs: {
        selectedAgent: agent,
        canonicalPath: canonicalTool.canonicalPath,
        shouldRunCanonicalHandler: true
      },
      at: new Date().toISOString()
    },
    {
      agent,
      decision: `Authorized canonical handler ${input.canonicalHandler} to execute ${input.canonicalTool}.`,
      inputs: {
        sessionId: input.sessionId,
        callId: input.callId,
        orgId: input.orgId,
        geminiToolCallId: input.geminiToolCallId
      },
      outputs: {
        canonicalHandler: input.canonicalHandler,
        canonicalTool: input.canonicalTool,
        shouldRunCanonicalHandler: true
      },
      at: new Date().toISOString()
    }
  ];
}

export function runSophiaAdkToolBridgeDecision(input: SophiaAdkToolExecutionInput): SophiaAdkToolExecutionOutput {
  const agent = agentForTool(input.canonicalTool);
  return {
    orchestrationVersion: 'sophia_adk_phase_2',
    agent,
    canonicalTool: input.canonicalTool,
    canonicalHandler: input.canonicalHandler,
    geminiToolName: input.geminiToolName,
    shouldRunCanonicalHandler: true,
    decision: `${agent} selected ${input.canonicalTool}; execution remains in ${input.canonicalHandler}.`,
    toolArgsShape: {
      keys: Object.keys(input.toolArgs).sort(),
      keyCount: Object.keys(input.toolArgs).length
    },
    trace: buildTrace(input, agent)
  };
}
