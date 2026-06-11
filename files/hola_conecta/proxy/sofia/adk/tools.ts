import { FunctionTool } from '@google/adk';
import { getOrgBusinessInfo } from '../../services/aiReadService.ts';
import { groundOfficeLocationWithGoogleMaps } from '../../services/maps/googleMapsGroundingService.ts';
import { loadSofiaBusinessKnowledgeVoiceContext } from '../../services/settings/sofiaSettingsService.ts';
import type { SophiaAdkToolName } from './types.ts';

export type SophiaAdkCanonicalTool = {
  name: SophiaAdkToolName;
  canonicalPath: string;
  description: string;
  adkTool: FunctionTool;
};

function unavailableToolResult(tool: SophiaAdkToolName, reason: string): Record<string, string | boolean> {
  return {
    ok: false,
    tool,
    reason
  };
}

export async function getBusinessKnowledge(input: { orgId: string }): Promise<Record<string, string | boolean>> {
  const businessKnowledge = await loadSofiaBusinessKnowledgeVoiceContext(input.orgId);
  return {
    ok: true,
    businessKnowledgeLoaded: businessKnowledge.trim().length > 0,
    businessKnowledge
  };
}

export async function GoogleMapsGroundingTool(input: {
  orgId: string;
  startingPoint?: string | null;
}): Promise<Record<string, unknown>> {
  const businessInfo = await getOrgBusinessInfo({ orgId: input.orgId });
  const primaryLocation = businessInfo.locations.find((location) => location.isPrimary)
    || businessInfo.locations.find((location) => location.locationType === 'physical' && Boolean(location.address))
    || null;
  const officeAddress = primaryLocation?.address || businessInfo.location;
  const grounding = await groundOfficeLocationWithGoogleMaps({
    officeAddress,
    businessName: businessInfo.businessName,
    startingPoint: input.startingPoint || null
  });
  return {
    ok: grounding.status !== 'missing_office_address',
    businessName: businessInfo.businessName,
    source: businessInfo.source,
    privateConectaOfficeData: {
      addressPresent: Boolean(officeAddress),
      parkingNotesPresent: Boolean(primaryLocation?.parkingNotes || businessInfo.parkingNotes),
      directionsNotesPresent: Boolean(primaryLocation?.directionsNotes || businessInfo.directionsNotes),
      hoursPresent: Boolean(primaryLocation?.hours || businessInfo.officeHours)
    },
    grounding
  };
}

function parseToolInputObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export const sophiaAdkCanonicalTools: SophiaAdkCanonicalTool[] = [
  {
    name: 'getSofiaSettings',
    canonicalPath: 'proxy/services/settings/sofiaSettingsService.ts',
    description: 'Loads Sophia/Sofia settings from the canonical settings service.',
    adkTool: new FunctionTool({
      name: 'getSofiaSettings',
      description: 'Load Sophia settings. Phase 1 exposes the canonical path and reserves execution for service integration.',
      execute: () => unavailableToolResult('getSofiaSettings', 'phase_1_trace_only')
    })
  },
  {
    name: 'getBusinessKnowledge',
    canonicalPath: 'proxy/services/settings/sofiaSettingsService.ts:loadSofiaBusinessKnowledgeVoiceContext',
    description: 'Loads enabled business custom instructions for Sophia voice context.',
    adkTool: new FunctionTool({
      name: 'getBusinessKnowledge',
      description: 'Load enabled business knowledge for a Conecta organization.',
      execute: (input) => {
        const parsedInput = parseToolInputObject(input);
        const orgId = parsedInput.orgId;
        if (typeof orgId !== 'string') {
          return unavailableToolResult('getBusinessKnowledge', 'org_id_required');
        }
        return getBusinessKnowledge({ orgId });
      }
    })
  },
  {
    name: 'GoogleMapsGroundingTool',
    canonicalPath: 'proxy/services/maps/googleMapsGroundingService.ts and proxy/services/voice/tools/receptionist/businessInfo.ts',
    description: 'Grounds verified Conecta office address, directions, landmarks, parking, and map-link requests with Google Maps.',
    adkTool: new FunctionTool({
      name: 'GoogleMapsGroundingTool',
      description: 'Use private Conecta office data and Google Maps grounding for office location, directions, nearby landmark, parking, and map link requests.',
      execute: (input) => {
        const parsedInput = parseToolInputObject(input);
        const orgId = parsedInput.orgId;
        const startingPoint = parsedInput.startingPoint;
        if (typeof orgId !== 'string') {
          return unavailableToolResult('GoogleMapsGroundingTool', 'org_id_required');
        }
        return GoogleMapsGroundingTool({
          orgId,
          startingPoint: typeof startingPoint === 'string' ? startingPoint : null
        });
      }
    })
  },
  {
    name: 'verifyCallerIdentity',
    canonicalPath: 'proxy/services/client/voicePinService.ts and proxy/services/voice/tools/identity/profile.ts',
    description: 'Verifies caller identity before private profile, refund, document, or status disclosure.',
    adkTool: new FunctionTool({
      name: 'verifyCallerIdentity',
      description: 'Verify caller identity through the existing voice PIN and identity tooling.',
      execute: () => unavailableToolResult('verifyCallerIdentity', 'phase_1_trace_only')
    })
  },
  {
    name: 'lookupAppointmentAvailability',
    canonicalPath: 'proxy/sofia/voice and proxy/sofia/services/sofiaVoiceBookingService.impl.ts',
    description: 'Looks up appointment availability through the existing Sofia booking runtime.',
    adkTool: new FunctionTool({
      name: 'lookupAppointmentAvailability',
      description: 'Look up appointment availability through canonical Sofia booking services.',
      execute: () => unavailableToolResult('lookupAppointmentAvailability', 'phase_1_trace_only')
    })
  },
  {
    name: 'lookupUpcomingBookings',
    canonicalPath: 'proxy/services/voice/tools/booking/lookupUpcomingBookings.ts',
    description: 'Looks up upcoming bookings through the existing Sofia booking runtime.',
    adkTool: new FunctionTool({
      name: 'lookupUpcomingBookings',
      description: 'Look up upcoming bookings through canonical Sofia booking services.',
      execute: () => unavailableToolResult('lookupUpcomingBookings', 'phase_2_trace_only')
    })
  },
  {
    name: 'createBooking',
    canonicalPath: 'proxy/services/voice/tools/booking/createBooking.ts',
    description: 'Creates an appointment through the existing Sofia booking runtime.',
    adkTool: new FunctionTool({
      name: 'createBooking',
      description: 'Create a booking through canonical Sofia booking services.',
      execute: () => unavailableToolResult('createBooking', 'phase_2_trace_only')
    })
  },
  {
    name: 'cancelBooking',
    canonicalPath: 'proxy/services/voice/tools/booking/cancelBooking.ts',
    description: 'Cancels an appointment through the existing Sofia booking runtime.',
    adkTool: new FunctionTool({
      name: 'cancelBooking',
      description: 'Cancel a booking through canonical Sofia booking services.',
      execute: () => unavailableToolResult('cancelBooking', 'phase_2_trace_only')
    })
  },
  {
    name: 'rescheduleBooking',
    canonicalPath: 'proxy/services/voice/tools/booking/rescheduleBooking.ts',
    description: 'Reschedules an appointment through the existing Sofia booking runtime.',
    adkTool: new FunctionTool({
      name: 'rescheduleBooking',
      description: 'Reschedule a booking through canonical Sofia booking services.',
      execute: () => unavailableToolResult('rescheduleBooking', 'phase_2_trace_only')
    })
  },
  {
    name: 'getDocumentStatus',
    canonicalPath: 'proxy/services/voice/tools/receptionist/documents.ts',
    description: 'Reads sanitized document request/upload status summaries.',
    adkTool: new FunctionTool({
      name: 'getDocumentStatus',
      description: 'Read sanitized document status through canonical receptionist tools.',
      execute: () => unavailableToolResult('getDocumentStatus', 'phase_1_trace_only')
    })
  },
  {
    name: 'getSignatureStatus',
    canonicalPath: 'proxy/services/voice/tools/receptionist/signatures.ts',
    description: 'Reads sanitized pending e-signature status summaries.',
    adkTool: new FunctionTool({
      name: 'getSignatureStatus',
      description: 'Read sanitized signature status through canonical receptionist tools.',
      execute: () => unavailableToolResult('getSignatureStatus', 'phase_1_trace_only')
    })
  },
  {
    name: 'prepareUserTransfer',
    canonicalPath: 'proxy/services/voice/tools/transfer/prepareUserTransfer.ts',
    description: 'Prepares a Sofia-to-user transfer using the existing phone transfer workflow.',
    adkTool: new FunctionTool({
      name: 'prepareUserTransfer',
      description: 'Prepare user transfer through canonical phone transfer services.',
      execute: () => unavailableToolResult('prepareUserTransfer', 'phase_1_trace_only')
    })
  },
  {
    name: 'fallbackToExternalPhone',
    canonicalPath: 'proxy/services/phone/phoneTransferSofiaLookupWorkflow.ts',
    description: 'Uses the existing external phone forwarding path when browser phone is unavailable.',
    adkTool: new FunctionTool({
      name: 'fallbackToExternalPhone',
      description: 'Fallback to configured external phone through canonical transfer workflow.',
      execute: () => unavailableToolResult('fallbackToExternalPhone', 'phase_1_trace_only')
    })
  },
  {
    name: 'transferToVoicemail',
    canonicalPath: 'proxy/services/phone/phoneTransferVoicemailWorkflow.ts',
    description: 'Starts provider voicemail on the existing conference when transfer cannot complete.',
    adkTool: new FunctionTool({
      name: 'transferToVoicemail',
      description: 'Transfer to voicemail through canonical phone voicemail workflow.',
      execute: () => unavailableToolResult('transferToVoicemail', 'phase_1_trace_only')
    })
  },
  {
    name: 'createCallbackFollowUp',
    canonicalPath: 'proxy/services/voice/tools/receptionist/callbackTask.ts',
    description: 'Creates a callback/follow-up through existing receptionist task tooling.',
    adkTool: new FunctionTool({
      name: 'createCallbackFollowUp',
      description: 'Create callback follow-up through canonical receptionist task tooling.',
      execute: () => unavailableToolResult('createCallbackFollowUp', 'phase_1_trace_only')
    })
  },
  {
    name: 'saveCallSummary',
    canonicalPath: 'proxy/services/phone/sofiaPhoneCallFinalizerService.ts',
    description: 'Saves the call summary through the existing phone finalizer.',
    adkTool: new FunctionTool({
      name: 'saveCallSummary',
      description: 'Save call summary through canonical phone finalizer.',
      execute: () => unavailableToolResult('saveCallSummary', 'phase_1_trace_only')
    })
  },
  {
    name: 'updateContactTimeline',
    canonicalPath: 'proxy/services/phone/phoneCallTimelineService.ts',
    description: 'Writes timeline activity through existing call/contact timeline services.',
    adkTool: new FunctionTool({
      name: 'updateContactTimeline',
      description: 'Update contact or call timeline through canonical timeline services.',
      execute: () => unavailableToolResult('updateContactTimeline', 'phase_1_trace_only')
    })
  }
];

export function findSophiaAdkTool(name: SophiaAdkToolName): SophiaAdkCanonicalTool {
  const tool = sophiaAdkCanonicalTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`SOFIA_ADK_TOOL_NOT_REGISTERED:${name}`);
  return tool;
}
