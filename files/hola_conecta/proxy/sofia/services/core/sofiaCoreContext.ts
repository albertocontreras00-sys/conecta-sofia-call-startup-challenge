import type { SofiaCoreChannel, SofiaCoreInput, SofiaCoreJsonObject, SofiaIdentityStatus } from './types.ts';

export type SofiaActorType = 'caller' | 'user' | 'visitor' | 'system' | 'unknown';

export type SofiaTrustLevel =
  | 'anonymous'
  | 'channel'
  | 'authenticated_user'
  | 'contact_matched'
  | 'verified_sensitive'
  | 'unknown';

export interface SofiaActorContext {
  actorType: SofiaActorType;
  orgId: string;
  contactId?: string | null;
  userId?: string | null;
  visitorId?: string | null;
  callerPhone?: string | null;
  email?: string | null;
  source?: string | null;
  identityStatus: SofiaIdentityStatus;
  trustLevel: SofiaTrustLevel;
  verifiedFactors: string[];
  metadata?: SofiaCoreJsonObject;
}

export interface SofiaChannelContext {
  channel: SofiaCoreChannel;
  entryPoint: string;
  sessionId: string | null;
  turnId: string | null;
  requestId?: string | null;
  callId?: string | null;
  conversationId?: string | null;
  pagePath?: string | null;
  pageUrl?: string | null;
  pageTitle?: string | null;
  language?: string | null;
  source?: string | null;
}

export interface SofiaContextEnvelope {
  actor: SofiaActorContext;
  channel: SofiaChannelContext;
  orgId: string;
  contactId?: string | null;
  userId?: string | null;
  visitorId?: string | null;
  safeMetadata?: SofiaCoreJsonObject;
}

export interface VoiceActorContextInput {
  orgId: string;
  callerPhone?: string | null;
  contactId?: string | null;
  identityStatus?: SofiaIdentityStatus;
  verifiedFactors?: string[];
  metadata?: SofiaCoreJsonObject;
}

export interface InternalChatActorContextInput {
  orgId: string;
  userId: string;
  source?: string | null;
  metadata?: SofiaCoreJsonObject;
}

export interface WebsiteChatActorContextInput {
  orgId: string;
  visitorId?: string | null;
  email?: string | null;
  source?: string | null;
  metadata?: SofiaCoreJsonObject;
}

export function buildVoiceActorContext(input: VoiceActorContextInput): SofiaActorContext {
  const identityStatus = input.contactId ? input.identityStatus ?? 'contact_matched' : input.identityStatus ?? 'unknown';

  return {
    actorType: 'caller',
    orgId: input.orgId,
    contactId: input.contactId ?? null,
    callerPhone: input.callerPhone ?? null,
    identityStatus,
    trustLevel: input.contactId ? 'contact_matched' : 'channel',
    verifiedFactors: input.verifiedFactors ?? ['voice_channel'],
    metadata: input.metadata ?? {}
  };
}

export function buildInternalChatActorContext(input: InternalChatActorContextInput): SofiaActorContext {
  return {
    actorType: 'user',
    orgId: input.orgId,
    userId: input.userId,
    source: input.source ?? null,
    identityStatus: 'user_authenticated',
    trustLevel: 'authenticated_user',
    verifiedFactors: ['logged_in_session'],
    metadata: input.metadata ?? {}
  };
}

export function buildWebsiteChatActorContext(input: WebsiteChatActorContextInput): SofiaActorContext {
  return {
    actorType: 'visitor',
    orgId: input.orgId,
    visitorId: input.visitorId ?? null,
    email: input.email ?? null,
    source: input.source ?? null,
    identityStatus: 'anonymous',
    trustLevel: 'anonymous',
    verifiedFactors: [],
    metadata: input.metadata ?? {}
  };
}

export interface VoiceChannelContextInput {
  sessionId: string;
  turnId: string;
  requestId?: string | null;
  callId?: string | null;
  language?: string | null;
  source?: string | null;
}

export interface InternalChatChannelContextInput {
  sessionId: string;
  requestId?: string | null;
  pagePath?: string | null;
  language?: string | null;
  source?: string | null;
  conversationId?: string | null;
}

export interface WebsiteChatChannelContextInput {
  sessionId: string;
  requestId?: string | null;
  pageUrl?: string | null;
  pageTitle?: string | null;
  language?: string | null;
  source?: string | null;
  conversationId?: string | null;
}

export function buildVoiceChannelContext(input: VoiceChannelContextInput): SofiaChannelContext {
  return {
    channel: 'voice',
    entryPoint: 'infobip_voice_websocket',
    sessionId: input.sessionId,
    turnId: input.turnId,
    requestId: input.requestId ?? null,
    callId: input.callId ?? null,
    language: input.language ?? null,
    source: input.source ?? null
  };
}

export function buildInternalChatChannelContext(input: InternalChatChannelContextInput): SofiaChannelContext {
  return {
    channel: 'internal_chat',
    entryPoint: 'api_sofia_chat',
    sessionId: input.sessionId,
    turnId: null,
    requestId: input.requestId ?? null,
    conversationId: input.conversationId ?? null,
    pagePath: input.pagePath ?? null,
    language: input.language ?? null,
    source: input.source ?? null
  };
}

export function buildWebsiteChatChannelContext(input: WebsiteChatChannelContextInput): SofiaChannelContext {
  return {
    channel: 'website_chat',
    entryPoint: 'api_website_chat',
    sessionId: input.sessionId,
    turnId: null,
    requestId: input.requestId ?? null,
    conversationId: input.conversationId ?? null,
    pageUrl: input.pageUrl ?? null,
    pageTitle: input.pageTitle ?? null,
    language: input.language ?? null,
    source: input.source ?? null
  };
}

function actorContextToJson(actor: SofiaActorContext): SofiaCoreJsonObject {
  return {
    actorType: actor.actorType,
    orgId: actor.orgId,
    contactId: actor.contactId ?? null,
    userId: actor.userId ?? null,
    visitorId: actor.visitorId ?? null,
    callerPhone: actor.callerPhone ?? null,
    email: actor.email ?? null,
    source: actor.source ?? null,
    identityStatus: actor.identityStatus,
    trustLevel: actor.trustLevel,
    verifiedFactors: actor.verifiedFactors,
    metadata: actor.metadata ?? {}
  };
}

function channelContextToJson(channel: SofiaChannelContext): SofiaCoreJsonObject {
  return {
    channel: channel.channel,
    entryPoint: channel.entryPoint,
    sessionId: channel.sessionId,
    turnId: channel.turnId,
    requestId: channel.requestId ?? null,
    callId: channel.callId ?? null,
    conversationId: channel.conversationId ?? null,
    pagePath: channel.pagePath ?? null,
    pageUrl: channel.pageUrl ?? null,
    pageTitle: channel.pageTitle ?? null,
    language: channel.language ?? null,
    source: channel.source ?? null
  };
}

function contextEnvelopeToJson(envelope: SofiaContextEnvelope): SofiaCoreJsonObject {
  return {
    actor: actorContextToJson(envelope.actor),
    channel: channelContextToJson(envelope.channel),
    orgId: envelope.orgId,
    contactId: envelope.contactId ?? null,
    userId: envelope.userId ?? null,
    visitorId: envelope.visitorId ?? null,
    safeMetadata: envelope.safeMetadata ?? {}
  };
}

export function attachSofiaContextEnvelope(input: SofiaCoreInput, envelope: SofiaContextEnvelope): SofiaCoreInput {
  return {
    ...input,
    actor: {
      identityStatus: envelope.actor.identityStatus,
      trustLevel: envelope.actor.trustLevel,
      verifiedFactors: envelope.actor.verifiedFactors,
      userId: envelope.actor.userId ?? null,
      contactId: envelope.actor.contactId ?? null,
      phone: envelope.actor.callerPhone ?? input.actor.phone ?? null,
      email: envelope.actor.email ?? input.actor.email ?? null,
      displayName: input.actor.displayName ?? null
    },
    context: {
      ...input.context,
      sofiaContext: contextEnvelopeToJson(envelope)
    }
  };
}
