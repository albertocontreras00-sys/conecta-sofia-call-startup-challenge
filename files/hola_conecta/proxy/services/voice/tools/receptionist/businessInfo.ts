import { logError } from '../../../../utils/logger.js';
import * as aiReadService from '../../../aiReadService.ts';
import { groundOfficeLocationWithGoogleMaps } from '../../../maps/googleMapsGroundingService.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import {
  logReceptionistBoundary,
  type RuntimeRecord,
  type SofiaReceptionistVoiceToolContext
} from './common.ts';

type BusinessInfoQuestionType =
  | 'office_address'
  | 'office_hours'
  | 'directions'
  | 'parking'
  | 'nearby_landmark'
  | 'map_link_request'
  | 'phone_number'
  | 'email'
  | 'website'
  | 'services_offered'
  | 'pricing'
  | 'documents_needed'
  | 'appointment_availability'
  | 'walk_ins'
  | 'languages_spoken'
  | 'payment_methods'
  | 'refunds_or_balances'
  | 'staff'
  | 'specific_preparer'
  | 'general';

function normalizeBusinessInfoQuestionType(value: string | null): BusinessInfoQuestionType {
  const normalized = value || 'general';
  if (
    normalized === 'office_address'
    || normalized === 'office_hours'
    || normalized === 'directions'
    || normalized === 'parking'
    || normalized === 'nearby_landmark'
    || normalized === 'map_link_request'
    || normalized === 'phone_number'
    || normalized === 'email'
    || normalized === 'website'
    || normalized === 'services_offered'
    || normalized === 'pricing'
    || normalized === 'documents_needed'
    || normalized === 'appointment_availability'
    || normalized === 'walk_ins'
    || normalized === 'languages_spoken'
    || normalized === 'payment_methods'
    || normalized === 'refunds_or_balances'
    || normalized === 'staff'
    || normalized === 'specific_preparer'
    || normalized === 'general'
  ) {
    return normalized;
  }
  return 'general';
}

function unavailableBusinessInfoMessage(questionType: BusinessInfoQuestionType): string {
  if (questionType === 'office_address' || questionType === 'directions' || questionType === 'parking' || questionType === 'nearby_landmark' || questionType === 'map_link_request') {
    return "I don't have that office address available right now, but I can take a message or have someone follow up.";
  }
  return "I don't have that information available right now, but I can take a message or have someone follow up.";
}

function verifiedAnswer(value: unknown, source: string): RuntimeRecord {
  return {
    answerStatus: 'verified',
    verified: true,
    value,
    source
  };
}

function unavailableAnswer(questionType: BusinessInfoQuestionType, source: string, reason: string): RuntimeRecord {
  return {
    answerStatus: 'unavailable',
    verified: false,
    value: null,
    source,
    reason,
    message: unavailableBusinessInfoMessage(questionType)
  };
}

function virtualOnlyAnswer(source: string): RuntimeRecord {
  return verifiedAnswer({
    locationType: 'virtual',
    message: "We're virtual, so we don't have a public office location. I can help you online, help book an appointment, help with documents, or take a message."
  }, source);
}

function noPhysicalLocationAnswer(source: string): RuntimeRecord {
  return verifiedAnswer({
    locationType: 'no_public_office',
    message: "We don't have a public office location. I can help you online or take a message for someone to follow up."
  }, source);
}

function getPrimaryBusinessLocation(info: Awaited<ReturnType<typeof aiReadService.getOrgBusinessInfo>>) {
  return info.locations.find((location) => location.isPrimary) || null;
}

function getRequestedBusinessLocation(
  info: Awaited<ReturnType<typeof aiReadService.getOrgBusinessInfo>>,
  requestedLocationName: string | null
) {
  const normalized = requestedLocationName?.trim().toLowerCase();
  if (!normalized) return null;
  return info.locations.find((location) => location.name.toLowerCase() === normalized)
    || info.locations.find((location) => location.name.toLowerCase().includes(normalized))
    || null;
}

function buildLocationListAnswer(info: Awaited<ReturnType<typeof aiReadService.getOrgBusinessInfo>>): RuntimeRecord | null {
  const locations = info.locations;
  if (locations.length <= 1) return null;
  const primaryLocation = getPrimaryBusinessLocation(info);
  if (primaryLocation) {
    return verifiedAnswer({
      primaryLocation,
      otherLocations: locations.filter((location) => location.id !== primaryLocation.id).map((location) => ({
        name: location.name,
        locationType: location.locationType,
        address: location.address
      })),
      instruction: 'Answer the primary location first and mention that other locations are also available.'
    }, 'org_locations.active_primary_location');
  }
  return verifiedAnswer({
    locations: locations.map((location) => ({
      name: location.name,
      locationType: location.locationType,
      address: location.locationType === 'physical' ? location.address : null
    })),
    message: 'Multiple locations are available. Ask which location the caller wants before answering location-specific details.'
  }, 'org_locations.active_location_list');
}

function buildSingleLocationAddressAnswer(info: Awaited<ReturnType<typeof aiReadService.getOrgBusinessInfo>>): RuntimeRecord | null {
  const location = info.locations.length === 1 ? info.locations[0] : getPrimaryBusinessLocation(info);
  if (!location) return null;
  if (location.locationType === 'virtual') {
    return verifiedAnswer({
      locationName: location.name,
      locationType: 'virtual',
      message: `${location.name} does not have a physical address. You can file online through the secure portal, and I can help book that option.`
    }, 'org_locations.virtual_location');
  }
  if (location.address) {
    return verifiedAnswer({
      locationName: location.name,
      address: location.address
    }, 'org_locations.physical_location_address');
  }
  return null;
}

function buildBusinessInfoAnswer(input: {
  questionType: BusinessInfoQuestionType;
  businessInfo: Awaited<ReturnType<typeof aiReadService.getOrgBusinessInfo>>;
  bookingConfig: Awaited<ReturnType<typeof aiReadService.getBookingConfig>> | null;
  requestedLocationName: string | null;
}): RuntimeRecord {
  const info = input.businessInfo;
  const requestedLocation = getRequestedBusinessLocation(info, input.requestedLocationName);
  if (input.questionType === 'office_address' || input.questionType === 'nearby_landmark' || input.questionType === 'map_link_request') {
    if (info.virtualOnly) return virtualOnlyAnswer('org.virtual_only');
    if (!info.hasPhysicalLocation) return noPhysicalLocationAnswer('org.has_physical_location');
    if (requestedLocation?.locationType === 'virtual') {
      return verifiedAnswer({
        locationName: requestedLocation.name,
        locationType: 'virtual',
        message: `${requestedLocation.name} does not have a physical address. You can file online through the secure portal, and I can help book that option.`
      }, 'org_locations.requested_virtual_location');
    }
    if (requestedLocation?.address) {
      return verifiedAnswer({
        locationName: requestedLocation.name,
        address: requestedLocation.address
      }, 'org_locations.requested_location_address');
    }
    const locationListAnswer = buildLocationListAnswer(info);
    if (locationListAnswer) return locationListAnswer;
    const locationAnswer = buildSingleLocationAddressAnswer(info);
    if (locationAnswer) return locationAnswer;
    return info.location
      ? verifiedAnswer(info.location, 'org.client_portal_address')
      : unavailableAnswer(input.questionType, 'org.client_portal_address', 'missing_verified_office_address');
  }
  if (input.questionType === 'directions') {
    if (info.virtualOnly) return virtualOnlyAnswer('org.virtual_only');
    if (!info.hasPhysicalLocation) return noPhysicalLocationAnswer('org.has_physical_location');
    const primaryLocation = requestedLocation || getPrimaryBusinessLocation(info);
    if (primaryLocation?.directionsNotes || primaryLocation?.address) {
      return verifiedAnswer({
        locationName: primaryLocation.name,
        officeAddress: primaryLocation.address,
        directionsNotes: primaryLocation.directionsNotes
      }, 'org_locations.primary_location_directions');
    }
    if (info.directionsNotes || info.location) {
      return verifiedAnswer({
        officeAddress: info.location,
        directionsNotes: info.directionsNotes
      }, 'org.directions_notes_or_client_portal_address');
    }
    return info.location
      ? verifiedAnswer({
        officeAddress: info.location,
        directionsNotes: null,
        limitation: 'Only the verified office address is available; no separate directions notes are configured.'
      }, 'org.client_portal_address')
      : unavailableAnswer(input.questionType, 'org.client_portal_address', 'missing_verified_office_address_for_directions');
  }
  if (input.questionType === 'office_hours') {
    const primaryLocation = requestedLocation || getPrimaryBusinessLocation(info);
    if (primaryLocation?.hours) {
      return verifiedAnswer({
        locationName: primaryLocation.name,
        hours: primaryLocation.hours
      }, 'org_locations.primary_location_hours');
    }
    return info.officeHours
      ? verifiedAnswer(info.officeHours, 'org.client_portal_hours')
      : unavailableAnswer(input.questionType, 'org.client_portal_hours', 'missing_verified_office_hours');
  }
  if (input.questionType === 'parking') {
    if (info.virtualOnly) return virtualOnlyAnswer('org.virtual_only');
    if (!info.hasPhysicalLocation) return noPhysicalLocationAnswer('org.has_physical_location');
    const primaryLocation = requestedLocation || getPrimaryBusinessLocation(info);
    const parkingNotes = primaryLocation?.parkingNotes || info.parkingNotes;
    return parkingNotes
      ? verifiedAnswer(parkingNotes, primaryLocation?.parkingNotes ? 'org_locations.primary_location_parking_notes' : 'org.parking_notes')
      : unavailableAnswer(input.questionType, 'org.parking_notes', 'missing_verified_parking_notes');
  }
  if (input.questionType === 'phone_number') {
    const primaryLocation = requestedLocation || getPrimaryBusinessLocation(info);
    if (primaryLocation?.phone) {
      return verifiedAnswer(primaryLocation.phone, 'org_locations.primary_location_phone');
    }
    return info.officePhone
      ? verifiedAnswer(info.officePhone, 'org.client_portal_office_phone_or_org_sender.sender_phone')
      : unavailableAnswer(input.questionType, 'org.client_portal_office_phone', 'missing_verified_office_phone');
  }
  if (input.questionType === 'email') {
    return info.email
      ? verifiedAnswer(info.email, 'org_sender.sender_email_external')
      : unavailableAnswer(input.questionType, 'org_sender.sender_email_external', 'missing_verified_office_email');
  }
  if (input.questionType === 'website') {
    const primaryLocation = requestedLocation || getPrimaryBusinessLocation(info);
    if (primaryLocation?.website) {
      return verifiedAnswer(primaryLocation.website, 'org_locations.primary_location_website');
    }
    return info.website
      ? verifiedAnswer(info.website, 'org.client_portal_website_or_org_sender.brand_website')
      : unavailableAnswer(input.questionType, 'org.client_portal_website', 'missing_verified_website');
  }
  if (input.questionType === 'walk_ins') {
    const primaryLocation = requestedLocation || getPrimaryBusinessLocation(info);
    const walkInsPolicy = primaryLocation?.walkInsPolicy || info.walkInsPolicy;
    return walkInsPolicy
      ? verifiedAnswer(walkInsPolicy, primaryLocation?.walkInsPolicy ? 'org_locations.primary_location_walk_ins_policy' : 'org.walk_ins_policy')
      : unavailableAnswer(input.questionType, 'org.walk_ins_policy', 'missing_verified_walk_ins_policy');
  }
  if (input.questionType === 'pricing') {
    return info.pricingPolicy
      ? verifiedAnswer(info.pricingPolicy, 'org.pricing_policy')
      : unavailableAnswer(input.questionType, 'org.pricing_policy', 'missing_verified_pricing_policy');
  }
  if (input.questionType === 'documents_needed') {
    return info.documentsNeededPolicy
      ? verifiedAnswer(info.documentsNeededPolicy, 'org.documents_needed_policy')
      : unavailableAnswer(input.questionType, 'org.documents_needed_policy', 'missing_verified_documents_needed_policy');
  }
  if (input.questionType === 'payment_methods') {
    return info.paymentMethodsPolicy
      ? verifiedAnswer(info.paymentMethodsPolicy, 'org.payment_methods_policy')
      : unavailableAnswer(input.questionType, 'org.payment_methods_policy', 'missing_verified_payment_methods_policy');
  }
  if (input.questionType === 'refunds_or_balances') {
    if (info.refundPolicy || info.balancePaymentPolicy) {
      return verifiedAnswer({
        refundPolicy: info.refundPolicy,
        balancePaymentPolicy: info.balancePaymentPolicy
      }, 'org.refund_policy_and_balance_payment_policy');
    }
    return unavailableAnswer(input.questionType, 'org.refund_policy_and_balance_payment_policy', 'missing_verified_refund_or_balance_policy');
  }
  if (input.questionType === 'appointment_availability') {
    return {
      answerStatus: 'use_specialized_tool',
      verified: true,
      source: 'get_available_slots',
      message: 'Use get_available_slots for appointment availability. Do not answer availability from memory.'
    };
  }
  if (input.questionType === 'services_offered' && input.bookingConfig?.events.length) {
    return verifiedAnswer({
      appointmentTypes: input.bookingConfig.events.map((event) => event.name)
    }, 'events.active_booking_event_names');
  }
  if ((input.questionType === 'staff' || input.questionType === 'specific_preparer') && input.bookingConfig?.bookableUsers.length) {
    return verifiedAnswer({
      bookableStaff: input.bookingConfig.bookableUsers.map((user) => [user.firstName, user.lastName].filter(Boolean).join(' ').trim()).filter(Boolean),
      availabilityInstruction: 'Use get_available_slots to answer whether a specific preparer has an open appointment time.'
    }, 'availability.bookable_team_members');
  }
  return unavailableAnswer(input.questionType, 'not_currently_available_to_sofia_voice', 'missing_verified_source_for_question_type');
}

function shouldGroundWithGoogleMaps(questionType: BusinessInfoQuestionType): boolean {
  return questionType === 'office_address'
    || questionType === 'directions'
    || questionType === 'parking'
    || questionType === 'nearby_landmark'
    || questionType === 'map_link_request';
}

function answerRecord(value: RuntimeRecord): RuntimeRecord {
  const nestedValue = value.value;
  return nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)
    ? nestedValue as RuntimeRecord
    : {};
}

function answerString(value: RuntimeRecord): string | null {
  return typeof value.value === 'string' && value.value.trim() ? value.value.trim() : null;
}

function addressFromAnswer(answer: RuntimeRecord): string | null {
  const direct = answerString(answer);
  if (direct) return direct;
  const record = answerRecord(answer);
  const address = record.address || record.officeAddress;
  return typeof address === 'string' && address.trim() ? address.trim() : null;
}

export async function handleLookupBusinessInfoTool(
  context: SofiaReceptionistVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const activeSession = context.session;
  if (!activeSession) return;
  const questionType = normalizeBusinessInfoQuestionType(stringArg(args, 'questionType'));
  const requestedPersonName = stringArg(args, 'requestedPersonName');
  const requestedLocationName = stringArg(args, 'requestedLocationName');
  const startingPoint = stringArg(args, 'generalStartingPoint');
  logReceptionistBoundary(context, 'voice.business_info.lookup.request_shape', 'lookup_business_info', toolCallId, {
    args,
    derived: {
      questionType,
      requestedPersonNamePresent: Boolean(requestedPersonName),
      requestedLocationNamePresent: Boolean(requestedLocationName),
      generalStartingPointPresent: Boolean(startingPoint)
    }
  });

  try {
    const needsBookingConfig = questionType === 'services_offered'
      || questionType === 'staff'
      || questionType === 'specific_preparer';
    const [businessInfo, bookingConfig] = await Promise.all([
      aiReadService.getOrgBusinessInfo({ orgId: activeSession.orgId }),
      needsBookingConfig ? aiReadService.getBookingConfig({ orgId: activeSession.orgId }) : Promise.resolve(null)
    ]);
    const answer = buildBusinessInfoAnswer({ questionType, businessInfo, bookingConfig, requestedLocationName });
    const grounding = shouldGroundWithGoogleMaps(questionType)
      ? await groundOfficeLocationWithGoogleMaps({
        officeAddress: addressFromAnswer(answer) || businessInfo.location,
        businessName: businessInfo.businessName,
        startingPoint
      })
      : null;
    logReceptionistBoundary(context, 'voice.business_info.lookup.response_shape', 'lookup_business_info', toolCallId, {
      questionType,
      answer,
      googleMapsGrounding: grounding,
      verifiedFields: businessInfo.verifiedFields,
      missingFields: businessInfo.missingFields,
      requestedPersonNamePresent: Boolean(requestedPersonName),
      requestedLocationNamePresent: Boolean(requestedLocationName),
      generalStartingPointPresent: Boolean(startingPoint)
    });
    context.sendGeminiToolResponse('lookup_business_info', toolCallId, {
      ok: true,
      questionType,
      requestedPersonName: requestedPersonName || null,
      requestedLocationName: requestedLocationName || null,
      answerStatus: answer.answerStatus,
      answer,
      googleMapsGrounding: grounding,
      followUpActionProposal: grounding?.maps_url
        ? {
          action: 'offer_map_link_sms',
          mapsUrl: grounding.maps_url,
          instruction: 'Offer to text this map link only when channel and consent rules allow it. This tool did not send the SMS. If the caller consents, call send_sms. Do not say the link was sent unless send_sms returns sent/success.'
        }
        : null,
      businessInfo: {
        businessName: businessInfo.businessName,
        timezone: businessInfo.timezone,
        location: businessInfo.location,
        officeHours: businessInfo.officeHours,
        officePhone: businessInfo.officePhone,
        email: businessInfo.email,
        website: businessInfo.website,
        hasPhysicalLocation: businessInfo.hasPhysicalLocation,
        virtualOnly: businessInfo.virtualOnly,
        locations: businessInfo.locations.map((location) => ({
          name: location.name,
          locationType: location.locationType,
          isPrimary: location.isPrimary,
          addressPresent: Boolean(location.address),
          hoursPresent: Boolean(location.hours),
          phonePresent: Boolean(location.phone)
        })),
        verifiedFields: businessInfo.verifiedFields,
        missingFields: businessInfo.missingFields,
        source: businessInfo.source
      },
      guardrail: {
        verifiedAnswerExists: answer.answerStatus === 'verified' || answer.answerStatus === 'use_specialized_tool',
        verifiedAnswerMissing: answer.answerStatus === 'unavailable',
        mapsGroundingUsed: grounding?.source_type === 'google_maps',
        callerAttributionDisclosureRequired: false,
        instruction: 'If verifiedAnswerMissing is true, say the verified answer is not available and offer to take a message or have someone follow up. Never invent business facts or landmarks. Only mention landmarks returned in googleMapsGrounding.nearby_landmarks or stored office notes. Do not add a spoken source disclosure for map grounding. If followUpActionProposal is present, it is only an offer/proposal; if the caller consents, call send_sms. Do not claim a map link was sent unless send_sms returns sent/success.'
      }
    });
  } catch (error) {
    logError(context.logContext, 'voice.business_info.lookup_failed', error, {
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      orgId: activeSession.orgId,
      questionType
    });
    context.sendGeminiToolResponse('lookup_business_info', toolCallId, {
      ok: false,
      errorCode: 'LOOKUP_BUSINESS_INFO_FAILED',
      questionType,
      answerStatus: 'unavailable',
      message: unavailableBusinessInfoMessage(questionType)
    });
  }
}
