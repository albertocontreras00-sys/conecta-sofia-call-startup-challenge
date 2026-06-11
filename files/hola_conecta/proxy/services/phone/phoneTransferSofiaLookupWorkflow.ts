import { getOrgPhoneWebrtcAccess } from '../../models/orgPhoneSettingsModel.ts';
import {
findTransferIntentForAnswer,
listPhoneUserExtensionsForVoiceLookup
} from '../../models/phoneUserExtensionsModel.ts';
import { SOFIA_TRANSFER_WEBRTC_FLOW } from '../../types/phoneTransferTypes.ts';
import { PhoneUserExtensionValidationError,type SofiaTransferLookupInput,type SofiaTransferLookupResult } from '../../types/phoneUserExtensionTypes.ts';
import { buildPhoneJsonEnvelope,logPhoneJsonEvent,type PhoneRoutingMatchStatus } from './phoneJsonContract.ts';
import { prepareTransferIntent } from './phoneTransferIntentWorkflowService.impl.ts';
import { startProviderTransferForPreparedIntent } from './phoneTransferProviderStartup.ts';
import { phoneLast4, resolveSofiaExternalForwardingEndpoint } from './phoneTransferEndpointService.ts';
import {
requireFreshWebrtcPresenceForSofiaTransfer
} from './phoneTransferTargetPresenceService.ts';
import { maybeStartInboundProviderVoicemail } from './phoneTransferVoicemailWorkflow.ts';
import {
extensionMatches,
nameMatches,
normalizeNameForMatch,
normalizeVoiceResponseLanguage
} from './phoneTransferWorkflowHelpers.ts';
import { assertValidExtension,toTransferUser } from './phoneUserExtensionSharedService.ts';

export async function prepareSofiaUserTransfer(input: SofiaTransferLookupInput): Promise<SofiaTransferLookupResult> {
  const requestedExtension = input.extension ? assertValidExtension(input.extension) : null;
  const requestedName = normalizeNameForMatch(input.requestedName);
  logPhoneJsonEvent('voice.json.sofia.prepare_user_transfer.request', buildPhoneJsonEnvelope({
    eventType: 'sofia.prepare_user_transfer.request',
    orgId: input.orgId,
    call: {
      phone_call_log_id: input.callLogId,
      direction: 'inbound',
      status: 'answered'
    },
    actor: { type: 'sofia' },
    routing: {
      requested_name: input.requestedName,
      requested_extension: requestedExtension
    },
    source: {
      sender: 'sofia_gemini_tool',
      converter: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
      receiver: 'phone_user_extensions',
      transport: 'gemini_tool',
      provider_event_type: 'prepare_user_transfer',
      provider_payload_shape: 'internal'
    },
    metadata: {
      org_isolation_enforced: true,
      caller_phrase_present: Boolean(input.callerPhrase)
    }
  }));

  const orgPhoneAccess = await getOrgPhoneWebrtcAccess(input.orgId);
  if (!orgPhoneAccess.allowed) {
    logPhoneJsonEvent('voice.json.sofia.prepare_user_transfer.result', buildPhoneJsonEnvelope({
      eventType: 'sofia.prepare_user_transfer.result',
      orgId: input.orgId,
      call: {
        phone_call_log_id: input.callLogId,
        direction: 'inbound',
        status: 'answered',
      },
      actor: { type: 'system' },
      routing: {
        requested_name: input.requestedName,
        requested_extension: requestedExtension,
        match_status: 'not_allowed',
      },
      source: {
        sender: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
        converter: 'transfer/prepareUserTransfer',
        receiver: 'gemini_live',
        transport: 'gemini_tool',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal',
      },
      metadata: {
        reason: orgPhoneAccess.reason,
      },
    }));
    return {
      matchStatus: 'not_allowed',
      matches: [],
      transferIntent: null,
      message: 'Browser phone transfer is not enabled for this office yet. I can take a message.',
      browserRingStarted: false,
      providerTransferStarted: false,
      providerTransferStatus: null,
    };
  }

  logPhoneJsonEvent('voice.json.extension.lookup.request', buildPhoneJsonEnvelope({
    eventType: 'extension.lookup.request',
    orgId: input.orgId,
    call: {
      phone_call_log_id: input.callLogId,
      direction: 'inbound',
      status: 'answered'
    },
    actor: { type: 'sofia' },
    routing: {
      requested_name: input.requestedName,
      requested_extension: requestedExtension
    },
    source: {
      sender: 'sofia_user_transfer_tool',
      converter: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
      receiver: 'phone_user_extensions',
      transport: 'internal_service',
      provider_event_type: 'lookup_extension',
      provider_payload_shape: 'internal'
    },
    metadata: {
      org_isolation_enforced: true
    }
  }));

  const rows = await listPhoneUserExtensionsForVoiceLookup(input.orgId);
  const matchedRows = rows.filter((row) => extensionMatches(row, requestedExtension) || nameMatches(row, requestedName));
  const inactiveRows = matchedRows.filter((row) => !row.is_active);
  const activeRows = matchedRows.filter((row) => row.is_active);
  const matches = activeRows.map(toTransferUser);
  let matchStatus: PhoneRoutingMatchStatus = 'none';
  if (inactiveRows.length > 0 && activeRows.length === 0) matchStatus = 'not_allowed';
  else if (matches.length === 1) matchStatus = 'single';
  else if (matches.length > 1) matchStatus = 'multiple';

  logPhoneJsonEvent('voice.json.extension.lookup.result', buildPhoneJsonEnvelope({
    eventType: 'extension.lookup.result',
    orgId: input.orgId,
    call: {
      phone_call_log_id: input.callLogId,
      direction: 'inbound',
      status: 'answered'
    },
    actor: { type: 'system' },
    routing: {
      requested_name: input.requestedName,
      requested_extension: requestedExtension,
      target_user_id: matches.length === 1 ? matches[0]?.user_id || null : null,
      target_extension: matches.length === 1 ? matches[0]?.extension || null : null,
      match_status: matchStatus
    },
    source: {
      sender: 'phone_user_extensions',
      converter: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
      receiver: 'sofia_user_transfer_tool',
      transport: 'internal_service',
      provider_event_type: 'lookup_extension',
      provider_payload_shape: 'internal'
    },
    metadata: {
      org_isolation_enforced: true,
      active_match_count: matches.length,
      inactive_match_count: inactiveRows.length
    }
  }));

  if (matchStatus !== 'single') {
    const message = matchStatus === 'multiple'
      ? 'I found more than one person with that name. Which one did you mean?'
      : matchStatus === 'not_allowed'
        ? 'That extension is not currently available. I can take a message.'
        : 'I could not find that extension. I can take a message.';
    const voicemailStarted = matchStatus !== 'multiple'
      ? await maybeStartInboundProviderVoicemail({
        orgId: input.orgId,
        callLogId: input.callLogId,
        reason: matchStatus === 'not_allowed' ? 'extension_not_allowed' : 'extension_not_found',
        voiceResponseLanguage: input.voiceResponseLanguage || null,
        requestedName: input.requestedName,
        requestedExtension,
      })
      : false;
    logPhoneJsonEvent('voice.json.sofia.prepare_user_transfer.result', buildPhoneJsonEnvelope({
      eventType: 'sofia.prepare_user_transfer.result',
      orgId: input.orgId,
      call: {
        phone_call_log_id: input.callLogId,
        direction: 'inbound',
        status: 'answered'
      },
      actor: { type: 'system' },
      routing: {
        requested_name: input.requestedName,
        requested_extension: requestedExtension,
        match_status: matchStatus
      },
      source: {
        sender: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
        converter: 'transfer/prepareUserTransfer',
        receiver: 'gemini_live',
        transport: 'gemini_tool',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal'
      }
    }));
    return {
      matchStatus,
      matches,
      transferIntent: null,
      message: voicemailStarted ? 'Please leave your message now. When you are finished, hang up.' : message,
      browserRingStarted: false,
      providerTransferStarted: false,
      providerTransferStatus: null,
    };
  }

  const target = matches[0];
  if (!target) {
    throw new PhoneUserExtensionValidationError('TRANSFER_TARGET_NOT_FOUND', 'Transfer target was not found', 400);
  }

  const webrtcPresence = await requireFreshWebrtcPresenceForSofiaTransfer({
    orgId: input.orgId,
    target,
    callLogId: input.callLogId,
    requestedName: input.requestedName,
    requestedExtension,
  });
  if (!webrtcPresence.available) {
    const externalForwardingEndpoint = resolveSofiaExternalForwardingEndpoint(target);
    if (externalForwardingEndpoint) {
      const externalForwardingMetadata = {
        external_forwarding: true,
        external_forwarding_reason: 'browser_phone_unavailable',
        external_forwarding_phone_last4: phoneLast4(target.external_forwarding_phone_number),
        browser_presence_unavailable_message: webrtcPresence.message,
      };
      logPhoneJsonEvent('voice.json.transfer_intent.external_forwarding.attempt', buildPhoneJsonEnvelope({
        eventType: 'transfer_intent.external_forwarding.attempt',
        orgId: input.orgId,
        call: {
          phone_call_log_id: input.callLogId,
          direction: 'inbound',
          status: 'answered',
        },
        actor: { type: 'sofia' },
        routing: {
          requested_name: input.requestedName,
          requested_extension: requestedExtension,
          target_user_id: target.user_id,
          target_extension: target.extension,
          match_status: 'single',
        },
        source: {
          sender: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
          converter: 'external_forwarding',
          receiver: 'infobip_calls_connect_api',
          transport: 'internal_service',
          provider_event_type: 'prepare_user_transfer',
          provider_payload_shape: 'internal',
        },
        metadata: externalForwardingMetadata,
      }));

      try {
        const transferIntent = await prepareTransferIntent({
          orgId: input.orgId,
          callLogId: input.callLogId,
          fromUserId: input.fromUserId,
          targetUserId: target.user_id,
          targetExtension: target.extension,
          reason: input.callerPhrase,
          metadata: {
            requested_name: input.requestedName,
            requested_extension: requestedExtension,
            caller_phrase_present: Boolean(input.callerPhrase),
            voice_response_language: normalizeVoiceResponseLanguage(input.voiceResponseLanguage),
            parent_call_id: input.parentCallId || null,
            dialog_id: input.dialogId || null,
            sofia_child_call_id: input.sofiaChildCallId || null,
            caller_number: input.callerNumber || null,
            source_route_phone: input.sourceRoutePhone || null,
            source_route_id: input.sourceRouteId || null,
            source: 'sofia_prepare_user_transfer_external_forwarding',
            ...externalForwardingMetadata,
          },
        });
        await startProviderTransferForPreparedIntent({
          orgId: input.orgId,
          target,
          transferIntent,
          endpointOverride: externalForwardingEndpoint,
          endpointMetadata: externalForwardingMetadata,
        });
        const providerStartedIntent = await findTransferIntentForAnswer(input.orgId, transferIntent.id);
        logPhoneJsonEvent('voice.json.transfer_intent.external_forwarding.started', buildPhoneJsonEnvelope({
          eventType: 'transfer_intent.external_forwarding.started',
          orgId: input.orgId,
          call: {
            phone_call_log_id: input.callLogId,
            direction: 'inbound',
            status: 'answered',
          },
          actor: { type: 'system' },
          routing: {
            requested_name: input.requestedName,
            requested_extension: requestedExtension,
            target_user_id: target.user_id,
            target_extension: target.extension,
            transfer_intent_id: transferIntent.id,
            match_status: 'single',
          },
          source: {
            sender: 'infobip_calls_connect_api',
            converter: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
            receiver: 'sofia_user_transfer_tool',
            transport: 'internal_service',
            provider_event_type: 'prepare_user_transfer',
            provider_payload_shape: 'calls_api',
          },
          metadata: {
            ...externalForwardingMetadata,
            provider_transfer_started: true,
            provider_transfer_status: providerStartedIntent?.status || null,
          },
        }));
        return {
          matchStatus,
          matches,
          transferIntent,
          message: `I found ${target.display_name || target.user_name || target.extension}. Please hold while I connect you.`,
          browserRingStarted: false,
          providerTransferStarted: true,
          providerTransferStatus: providerStartedIntent?.status || null,
        };
      } catch (error) {
        logPhoneJsonEvent('voice.json.transfer_intent.external_forwarding.failed', buildPhoneJsonEnvelope({
          eventType: 'transfer_intent.external_forwarding.failed',
          orgId: input.orgId,
          call: {
            phone_call_log_id: input.callLogId,
            direction: 'inbound',
            status: 'failed',
          },
          actor: { type: 'system' },
          routing: {
            requested_name: input.requestedName,
            requested_extension: requestedExtension,
            target_user_id: target.user_id,
            target_extension: target.extension,
            match_status: 'single',
          },
          source: {
            sender: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
            converter: 'external_forwarding',
            receiver: 'existing_transfer_fallback',
            transport: 'internal_service',
            provider_event_type: 'prepare_user_transfer',
            provider_payload_shape: 'internal',
          },
          metadata: {
            ...externalForwardingMetadata,
            error_message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    }

    const voicemailStarted = await maybeStartInboundProviderVoicemail({
      orgId: input.orgId,
      callLogId: input.callLogId,
      reason: 'target_not_available',
      voiceResponseLanguage: input.voiceResponseLanguage || null,
      targetUserId: target.user_id,
      targetExtension: target.extension,
      requestedName: input.requestedName,
      requestedExtension,
    });
    logPhoneJsonEvent('voice.json.sofia.prepare_user_transfer.result', buildPhoneJsonEnvelope({
      eventType: 'sofia.prepare_user_transfer.result',
      orgId: input.orgId,
      call: {
        phone_call_log_id: input.callLogId,
        direction: 'inbound',
        status: 'answered',
      },
      actor: { type: 'system' },
      routing: {
        requested_name: input.requestedName,
        requested_extension: requestedExtension,
        target_user_id: target.user_id,
        target_extension: target.extension,
        match_status: 'single',
      },
      source: {
        sender: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
        converter: 'transfer/prepareUserTransfer',
        receiver: 'gemini_live',
        transport: 'gemini_tool',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal',
      },
      metadata: {
        transfer_endpoint_type: target.transfer_endpoint_type,
        provider_transfer_started: false,
        browser_ring_started: false,
        reason: 'webrtc_target_not_freshly_available',
      },
    }));
    return {
      matchStatus,
      matches,
      transferIntent: null,
      message: voicemailStarted ? 'Please leave your message now. When you are finished, hang up.' : webrtcPresence.message,
      browserRingStarted: false,
      providerTransferStarted: false,
      providerTransferStatus: null,
    };
  }

  logPhoneJsonEvent('voice.json.transfer_intent.create.request', buildPhoneJsonEnvelope({
    eventType: 'transfer_intent.create.request',
    orgId: input.orgId,
    call: {
      phone_call_log_id: input.callLogId,
      direction: 'inbound',
      status: 'answered'
    },
    actor: { type: 'sofia' },
    routing: {
      requested_name: input.requestedName,
      requested_extension: requestedExtension,
      target_user_id: target.user_id,
      target_extension: target.extension,
      match_status: 'single'
    },
    source: {
      sender: 'sofia_user_transfer_tool',
      converter: 'phoneUserExtensionsService.prepareTransferIntent',
      receiver: 'phone_user_transfer_intents',
      transport: 'internal_service',
      provider_event_type: 'prepare_user_transfer',
      provider_payload_shape: 'internal'
    }
  }));

  try {
    const transferIntent = await prepareTransferIntent({
      orgId: input.orgId,
      callLogId: input.callLogId,
      fromUserId: input.fromUserId,
      targetUserId: target.user_id,
      targetExtension: target.extension,
      reason: input.callerPhrase,
      metadata: {
        requested_name: input.requestedName,
        requested_extension: requestedExtension,
        caller_phrase_present: Boolean(input.callerPhrase),
        voice_response_language: normalizeVoiceResponseLanguage(input.voiceResponseLanguage),
        parent_call_id: input.parentCallId || null,
        dialog_id: input.dialogId || null,
        sofia_child_call_id: input.sofiaChildCallId || null,
        caller_number: input.callerNumber || null,
        source_route_phone: input.sourceRoutePhone || null,
        source_route_id: input.sourceRouteId || null,
        source: 'sofia_prepare_user_transfer'
      }
    });
    await startProviderTransferForPreparedIntent({
      orgId: input.orgId,
      target,
      transferIntent,
    });
    const providerStartedIntent = await findTransferIntentForAnswer(input.orgId, transferIntent.id);
    logPhoneJsonEvent('voice.json.transfer_intent.created', buildPhoneJsonEnvelope({
      eventType: 'transfer_intent.created',
      orgId: input.orgId,
      call: {
        phone_call_log_id: input.callLogId,
        direction: 'inbound',
        status: 'answered'
      },
      actor: { type: 'system' },
      routing: {
        requested_name: input.requestedName,
        requested_extension: requestedExtension,
        target_user_id: target.user_id,
        target_extension: target.extension,
        transfer_intent_id: transferIntent.id,
        match_status: 'single'
      },
      source: {
        sender: 'phone_user_transfer_intents',
        converter: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
        receiver: 'sofia_user_transfer_tool',
        transport: 'internal_service',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal'
      },
      metadata: {
        flow_map: [...SOFIA_TRANSFER_WEBRTC_FLOW],
        browser_ring_started: true,
        provider_transfer_started: true,
        provider_transfer_status: providerStartedIntent?.status || null,
      }
    }));
    logPhoneJsonEvent('voice.json.sofia.prepare_user_transfer.result', buildPhoneJsonEnvelope({
      eventType: 'sofia.prepare_user_transfer.result',
      orgId: input.orgId,
      call: {
        phone_call_log_id: input.callLogId,
        direction: 'inbound',
        status: 'answered'
      },
      actor: { type: 'system' },
      routing: {
        requested_name: input.requestedName,
        requested_extension: requestedExtension,
        target_user_id: target.user_id,
        target_extension: target.extension,
        transfer_intent_id: transferIntent.id,
        match_status: 'single'
      },
      source: {
        sender: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
        converter: 'transfer/prepareUserTransfer',
        receiver: 'gemini_live',
        transport: 'gemini_tool',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal'
      }
    }));
    return {
      matchStatus,
      matches,
      transferIntent,
      message: `I found ${target.display_name || target.user_name || target.extension}. Please hold while I connect you.`,
      browserRingStarted: true,
      providerTransferStarted: true,
      providerTransferStatus: providerStartedIntent?.status || null,
    };
  } catch (error) {
    logPhoneJsonEvent('voice.json.transfer_intent.failed', buildPhoneJsonEnvelope({
      eventType: 'transfer_intent.failed',
      orgId: input.orgId,
      call: {
        phone_call_log_id: input.callLogId,
        direction: 'inbound',
        status: 'failed'
      },
      actor: { type: 'system' },
      routing: {
        requested_name: input.requestedName,
        requested_extension: requestedExtension,
        target_user_id: target.user_id,
        target_extension: target.extension,
        match_status: 'single'
      },
      source: {
        sender: 'phoneUserExtensionsService.prepareTransferIntent',
        converter: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
        receiver: 'sofia_user_transfer_tool',
        transport: 'internal_service',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal'
      },
      metadata: {
        flow_map: [...SOFIA_TRANSFER_WEBRTC_FLOW],
        browser_ring_started: false,
        provider_transfer_started: false,
        error_message: error instanceof Error ? error.message : String(error)
      }
    }));
    throw error;
  }
}
