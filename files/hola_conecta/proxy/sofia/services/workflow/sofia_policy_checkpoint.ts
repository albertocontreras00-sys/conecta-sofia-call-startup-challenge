import type {
  SofiaAgentPlan,
  SofiaIdentityContext,
  SofiaMemoryContext,
  SofiaPolicyDecision,
  SofiaToolResult
} from '../../shared/sofiaWorkflow.ts';

export interface SofiaPolicyCheckpointInput {
  identity: SofiaIdentityContext;
  memory: SofiaMemoryContext;
  plan?: SofiaAgentPlan | null;
  toolResults?: SofiaToolResult[];
  draftResponseText?: string | null;
}

export function evaluateSofiaPolicyDecision(input: SofiaPolicyCheckpointInput): SofiaPolicyDecision {
  const toolResults = input.toolResults ?? [];
  const failedTools = toolResults.filter((result) => result.status === 'failed' || result.status === 'blocked');
  const succeededTools = toolResults.filter((result) => result.status === 'succeeded');
  const requiresHumanHandoff = Boolean(input.plan?.requiresHumanHandoff || failedTools.length > 0);

  return {
    status: requiresHumanHandoff ? 'handoff' : 'allow',
    reasons: failedTools.map((result) => `${result.toolName}:${result.status}`),
    allowedClaims: succeededTools.map((result) => result.toolName),
    blockedClaims: failedTools.map((result) => result.toolName),
    requiresHumanHandoff,
    safeMemoryScopes: input.identity.allowedMemoryScopes.filter((scope) => !scope.toLowerCase().includes('sensitive')),
    metadata: {
      checkpoint: 'sofia_policy_checkpoint',
      draftResponseAvailable: Boolean(input.draftResponseText),
      memorySource: input.memory.source
    }
  };
}
