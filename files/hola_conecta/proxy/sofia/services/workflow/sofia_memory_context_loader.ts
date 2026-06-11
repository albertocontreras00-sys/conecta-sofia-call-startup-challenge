import type {
  SofiaIdentityContext,
  SofiaInteractionEnvelope,
  SofiaJsonObject,
  SofiaMemoryContext
} from '../../shared/sofiaWorkflow.ts';

export interface SofiaMemoryContextLoaderInput {
  envelope: SofiaInteractionEnvelope;
  identity: SofiaIdentityContext;
  providedMemory?: Partial<SofiaMemoryContext> | null;
}

export function loadSofiaMemoryContext(input: SofiaMemoryContextLoaderInput): SofiaMemoryContext {
  const provided = input.providedMemory;
  const safeFacts = provided?.safeFacts && !Array.isArray(provided.safeFacts) ? provided.safeFacts : {};
  const metadata: SofiaJsonObject = {
    loader: 'sofia_memory_context_loader',
    writeEnabled: false
  };

  return {
    orgId: input.envelope.orgId,
    contactId: input.identity.contactId ?? input.envelope.contactId ?? null,
    languagePreference: provided?.languagePreference ?? input.identity.language ?? input.envelope.language ?? null,
    officePreference: provided?.officePreference ?? null,
    relationshipContext: provided?.relationshipContext ?? null,
    priorSummaries: provided?.priorSummaries ?? [],
    priorPromises: provided?.priorPromises ?? [],
    safeFacts,
    sensitiveFactsAvailable: provided?.sensitiveFactsAvailable ?? false,
    loadedAt: provided?.loadedAt ?? new Date().toISOString(),
    source: provided?.source ?? 'not_loaded',
    metadata
  };
}
