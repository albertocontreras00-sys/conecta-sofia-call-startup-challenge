import type {
  SofiaIdentityContext,
  SofiaInteractionEnvelope,
  SofiaMemoryContext,
  SofiaPersonaGuidance,
  SofiaPolicyDecision
} from '../../shared/sofiaWorkflow.ts';

export interface SofiaPersonaAgentInput {
  envelope: SofiaInteractionEnvelope;
  identity: SofiaIdentityContext;
  memory: SofiaMemoryContext;
  policy: SofiaPolicyDecision;
}

export function createSofiaPersonaGuidance(input: SofiaPersonaAgentInput): SofiaPersonaGuidance {
  const language = (input.memory.languagePreference || input.envelope.language || input.identity.language || '').toLowerCase();
  const languageStyle = language.startsWith('es') || language.includes('spanish') ? 'spanish' : 'match_user';

  return {
    tone: input.policy.requiresHumanHandoff ? 'apologetic' : 'warm',
    languageStyle,
    officeStyle: input.memory.officePreference ?? null,
    humanTeamPersonality: null,
    permittedMemoryReferences: input.policy.safeMemoryScopes,
    constraints: [
      'do_not_override_policy',
      'do_not_claim_unconfirmed_tool_success',
      'do_not_reveal_sensitive_memory'
    ],
    metadata: {
      agent: 'sofia_persona_agent',
      policyStatus: input.policy.status
    }
  };
}
