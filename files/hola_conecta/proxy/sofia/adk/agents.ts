import { Agent, SequentialAgent } from '@google/adk';
import { sophiaAdkCanonicalTools } from './tools.ts';

const model = process.env.SOPHIA_ADK_MODEL || process.env.SOFIA_ADK_MODEL || 'gemini-flash-latest';

export const languageIntentAgent = new Agent({
  name: 'LanguageIntentAgent',
  model,
  instruction: [
    'Detect the caller response language and all user intents.',
    'Handle bilingual English and Spanish calls.',
    'When a caller asks for more than one thing, preserve every intent instead of collapsing to one.'
  ].join(' ')
});

export const officeKnowledgeAgent = new Agent({
  name: 'OfficeKnowledgeAgent',
  model,
  instruction: [
    'Load Sophia settings, business custom instructions, office hours, services, and policies.',
    'Ground office location, directions, parking, landmarks, and map links with Google Maps when a verified Conecta office address exists.',
    'Use private Conecta knowledge only through registered tools.',
    'Do not invent business facts or landmarks when the canonical knowledge tools do not return them.'
  ].join(' '),
  tools: sophiaAdkCanonicalTools
    .filter((tool) => tool.name === 'getSofiaSettings' || tool.name === 'getBusinessKnowledge' || tool.name === 'GoogleMapsGroundingTool')
    .map((tool) => tool.adkTool)
});

export const complianceSafetyAgent = new Agent({
  name: 'ComplianceSafetyAgent',
  model,
  instruction: [
    'Enforce identity and privacy gates for tax-office voice calls.',
    'Block private refund, balance, document, signature, or profile details unless the caller is verified.',
    'Do not provide tax or legal advice. Route complex judgment requests to staff follow-up.'
  ].join(' '),
  tools: sophiaAdkCanonicalTools
    .filter((tool) => tool.name === 'verifyCallerIdentity')
    .map((tool) => tool.adkTool)
});

export const routingEscalationAgent = new Agent({
  name: 'RoutingEscalationAgent',
  model,
  instruction: [
    'Decide whether Sophia should answer, transfer, fallback to external phone, start voicemail, or create a callback.',
    'Use existing Conecta phone routing and transfer tools.',
    'Do not create duplicate transfer paths.'
  ].join(' '),
  tools: sophiaAdkCanonicalTools
    .filter((tool) => tool.name === 'prepareUserTransfer' || tool.name === 'fallbackToExternalPhone' || tool.name === 'transferToVoicemail')
    .map((tool) => tool.adkTool)
});

export const followUpActionAgent = new Agent({
  name: 'FollowUpActionAgent',
  model,
  instruction: [
    'Create or propose follow-up actions using canonical Conecta services.',
    'Save call summaries, callback requests, CRM activity, and timeline updates through existing tools only.'
  ].join(' '),
  tools: sophiaAdkCanonicalTools
    .filter((tool) => tool.name === 'createCallbackFollowUp' || tool.name === 'saveCallSummary' || tool.name === 'updateContactTimeline')
    .map((tool) => tool.adkTool)
});

export const sophiaOrchestratorAgent = new Agent({
  name: 'SophiaOrchestratorAgent',
  model,
  instruction: [
    'Coordinate Sophia sub-agents for production tax-office front-office decisions.',
    'Use language, office knowledge, safety, routing, and follow-up outputs to choose the final action.',
    'Return structured decisions suitable for a live voice session or post-call finalization trace.'
  ].join(' ')
});

export const sophiaAdkSequentialAgent = new SequentialAgent({
  name: 'SophiaAdkPhaseOneSequentialOrchestration',
  subAgents: [
    languageIntentAgent,
    officeKnowledgeAgent,
    complianceSafetyAgent,
    routingEscalationAgent,
    followUpActionAgent,
    sophiaOrchestratorAgent
  ]
});

export const sophiaAdkAgents = {
  sophiaOrchestratorAgent,
  languageIntentAgent,
  officeKnowledgeAgent,
  complianceSafetyAgent,
  routingEscalationAgent,
  followUpActionAgent,
  sophiaAdkSequentialAgent
};
