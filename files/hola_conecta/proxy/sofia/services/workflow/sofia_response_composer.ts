import type {
  SofiaComposedResponse,
  SofiaInteractionEnvelope,
  SofiaPersonaGuidance,
  SofiaPolicyDecision
} from '../../shared/sofiaWorkflow.ts';

export interface SofiaResponseComposerInput {
  envelope: SofiaInteractionEnvelope;
  policy: SofiaPolicyDecision;
  persona: SofiaPersonaGuidance;
  responseText: string;
  shouldEndInteraction?: boolean;
}

export function composeSofiaResponse(input: SofiaResponseComposerInput): SofiaComposedResponse {
  return {
    channel: input.envelope.channel,
    text: input.responseText,
    language: input.envelope.language ?? null,
    shouldEndInteraction: input.shouldEndInteraction ?? false,
    metadata: {
      composer: 'sofia_response_composer',
      policyStatus: input.policy.status,
      personaTone: input.persona.tone
    }
  };
}
