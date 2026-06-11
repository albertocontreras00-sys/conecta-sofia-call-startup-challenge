import bookingService from '../../services/bookings/bookingService.ts';
import {
  getOrgTimezoneForSofiaVoiceBooking,
  listSofiaVoiceEventAvailability,
  listEligibleBookableStaffForEvent,
  type SofiaVoiceEventAvailabilityRow,
  type SofiaVoiceBookingEventRow,
  type SofiaVoiceBookingStaffRow
} from '../../models/sofiaVoiceBookingModel.ts';
import * as contactModel from '../../models/contact/index.ts';
import * as clientContactModel from '../../models/clientContactModel.ts';
import { isValidTimezone } from '../../utils/timezone.ts';
import { logError, logInfo } from '../../utils/logger.js';
import { getOrCreateSofiaVoiceBookingEvents } from './sofiaVoiceBookingDefaults.ts';
import {
  createSofiaVoiceBookingOptionToken,
  verifySofiaVoiceBookingOptionToken
} from './sofiaVoiceBookingOptionToken.ts';
import {
  enqueueVoiceBookingConfirmationSmsJob,
  enqueueVoiceBookingStatusSmsJob
} from '../../services/bookings/bookingAsyncJobService.ts';
import type { SofiaVoiceBookingObservability } from './sofiaVoiceBookingSmsService.ts';
import type { JsonObject } from '../../types/json.ts';
import type { AvailabilitySlotsDiagnostics } from '../../types/booking.ts';
import type {
  SofiaPreferredTimeRelation,
  SofiaPreferredTimeWindow,
  SofiaVoiceBookingEventSelection
} from '../../services/voice/voiceSessionTypes.ts';
import {
  buildSearchDates,
  dateKeyInTimezone,
  filterSlotsByEventAvailability,
  filterSlotsByPreference,
  formatSlotForVoice,
  getStaffDisambiguation,
  isGenericSofiaVoiceEventName,
  localSlotStartMinutes,
  orderStaffForVoiceBooking,
  staffName,
  timeToMinutes
} from './sofiaVoiceBookingFormatHelpers.ts';

export type SofiaVoiceBookingOption = {
  staffMemberId: string;
  staffMemberName: string;
  eventId: string;
  eventName: string;
  startTime: string;
  endTime: string;
  timezone: string;
  durationMinutes: number;
  displayText: string;
  optionToken: string;
};

export type SofiaVoiceBookingOptionsResult = {
  options: SofiaVoiceBookingOption[];
  defaultOption: SofiaVoiceBookingOption | null;
  source: string;
  missingRequirements: string[];
  eventSelectionRequired?: boolean;
  availableEvents?: SofiaVoiceBookingEventSelection[];
  eventSelectionPrompt?: string;
  preferenceMatched?: boolean;
  diagnostics?: AvailabilitySlotsDiagnostics[];
  staffDisambiguation?: {
    requestedName: string;
    matches: string[];
  } | null;
};

export type CreateSofiaVoiceBookingResult = {
  bookingId: string;
  startTime: string;
  staffMemberName: string;
  timezone: string;
  smsSent: boolean;
  smsStatus: string | null;
  smsQueued?: boolean;
  contactId: string | null;
};

export type VoiceBookingLookupSummary = {
  bookingId: string;
  startTime: string;
  endTime: string | null;
  timezone: string;
  staffMemberName: string | null;
  eventName: string | null;
  status: string | null;
};

export type MutateVoiceBookingResult = {
  bookingId: string;
  status: string | null;
  startTime: string;
  endTime: string | null;
  timezone: string;
  staffMemberName: string | null;
  eventName: string | null;
  smsQueued?: boolean;
  smsStatus?: string | null;
};

type LookupUpcomingVoiceBookingsInput = {
  orgId: string;
  callerPhone: string;
  now?: Date;
  limit?: number;
  deps?: Partial<LookupUpcomingVoiceBookingsDeps>;
};

type LookupUpcomingVoiceBookingsDeps = {
  findContactsByPhone: typeof contactModel.findContactsByPhone;
  getUpcomingBookingsForVoiceCaller: typeof bookingService.getUpcomingBookingsForVoiceCaller;
};

type CancelVoiceBookingInput = {
  orgId: string;
  callerPhone: string;
  bookingId: string;
  reason?: string | null;
  now?: Date;
  observability?: SofiaVoiceBookingObservability;
  deps?: Partial<CancelVoiceBookingDeps>;
};

type CancelVoiceBookingDeps = {
  lookupUpcomingVoiceBookings: typeof lookupUpcomingVoiceBookings;
  cancelBooking: typeof bookingService.cancelBooking;
  enqueueVoiceBookingStatusSmsJob: typeof enqueueVoiceBookingStatusSmsJob;
};

type RescheduleVoiceBookingInput = {
  orgId: string;
  callerPhone: string;
  bookingId: string;
  selectedOption: SofiaVoiceBookingOption;
  confirmationReceived: boolean;
  now?: Date;
  observability?: SofiaVoiceBookingObservability;
  deps?: Partial<RescheduleVoiceBookingDeps>;
};

type RescheduleVoiceBookingDeps = {
  lookupUpcomingVoiceBookings: typeof lookupUpcomingVoiceBookings;
  revalidateSelectedOption: typeof revalidateSelectedOption;
  updateBooking: typeof bookingService.updateBooking;
  enqueueVoiceBookingStatusSmsJob: typeof enqueueVoiceBookingStatusSmsJob;
};

type GetSofiaVoiceBookingOptionsInput = {
  orgId: string;
  callerPhone: string;
  preferredStaffName?: string | null;
  preferredDateTime?: string | null;
  preferredDate?: string | null;
  preferredTime?: string | null;
  preferredTimeRelation?: SofiaPreferredTimeRelation | null;
  preferredTimeWindow?: SofiaPreferredTimeWindow | null;
  preferredEventId?: string | null;
  preferredEndDate?: string | null;
  horizonDays?: number | null;
  limit?: number;
  now?: Date;
  tokenIssuedAt?: Date;
  observability?: SofiaVoiceBookingObservability;
  excludeBookingId?: string | null;
  deps?: Partial<GetSofiaVoiceBookingOptionsDeps>;
};

type CreateSofiaVoiceBookingInput = {
  orgId: string;
  callerPhone: string;
  smsPhoneOverride?: string | null;
  contactId?: string | null;
  selectedOption: SofiaVoiceBookingOption;
  confirmationReceived: boolean;
  observability?: SofiaVoiceBookingObservability;
  deps?: Partial<CreateSofiaVoiceBookingDeps>;
};

type CreateSofiaVoiceBookingDeps = {
  revalidateSelectedOption: typeof revalidateSelectedOption;
  resolveOrCreateCallerContact: typeof resolveOrCreateCallerContact;
  ensureClientContact: typeof ensureClientContact;
  createBooking: typeof bookingService.createBooking;
  enqueueVoiceBookingConfirmationSmsJob: typeof enqueueVoiceBookingConfirmationSmsJob;
};

type GetSofiaVoiceBookingOptionsDeps = {
  getOrgTimezoneForSofiaVoiceBooking: typeof getOrgTimezoneForSofiaVoiceBooking;
  getOrCreateSofiaVoiceBookingEvents: typeof getOrCreateSofiaVoiceBookingEvents;
  listEligibleBookableStaffForEvent: typeof listEligibleBookableStaffForEvent;
  getAvailableSlots: typeof bookingService.getAvailableSlotsDetailed;
  listSofiaVoiceEventAvailability: typeof listSofiaVoiceEventAvailability;
};

type ContactLike = {
  id?: string | null;
  org_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  deleted_at?: unknown;
};

const DEFAULT_OPTION_LIMIT = 3;
const LOG_CONTEXT = 'sofiaVoiceBookingService';

export async function getSofiaBookingOptions(
  input: GetSofiaVoiceBookingOptionsInput
): Promise<SofiaVoiceBookingOptionsResult> {
  const deps: GetSofiaVoiceBookingOptionsDeps = {
    getOrgTimezoneForSofiaVoiceBooking,
    getOrCreateSofiaVoiceBookingEvents,
    listEligibleBookableStaffForEvent,
    getAvailableSlots: bookingService.getAvailableSlotsDetailed.bind(bookingService),
    listSofiaVoiceEventAvailability,
    ...(input.deps || {})
  };
  const limit = normalizeLimit(input.limit);
  const orgTimezone = await deps.getOrgTimezoneForSofiaVoiceBooking(input.orgId);
  const missingRequirements: string[] = [];

  if (!orgTimezone || !isValidTimezone(orgTimezone)) {
    missingRequirements.push('Organization timezone must be configured before Sofia can book appointments by voice.');
    return emptyOptions('sofia_voice_booking', missingRequirements);
  }

  let events: SofiaVoiceBookingEventRow[];
  try {
    events = await deps.getOrCreateSofiaVoiceBookingEvents(input.orgId);
  } catch (error) {
    logError('sofiaVoiceBookingService.getSofiaBookingOptions', 'Failed to resolve Sofia voice booking event', error, {
      orgId: input.orgId
    });
    missingRequirements.push('Sofia voice booking event could not be created for this organization.');
    return emptyOptions('sofia_voice_booking', missingRequirements);
  }
  if (!events.length) {
    missingRequirements.push('Sofia voice booking event could not be created for this organization.');
    return emptyOptions('sofia_voice_booking', missingRequirements);
  }
  const availableEvents = events.map(toEventSelection);
  if (events.length > 1 && !input.preferredEventId) {
    return {
      ...emptyOptions('sofia_voice_booking', []),
      eventSelectionRequired: true,
      availableEvents,
      eventSelectionPrompt: eventSelectionPromptForEvents(events)
    };
  }
  const selectedEvents = input.preferredEventId
    ? events.filter((event) => event.id === input.preferredEventId)
    : events;
  if (!selectedEvents.length) {
    missingRequirements.push('The selected Sofia voice booking event is not available.');
    return emptyOptions('sofia_voice_booking', missingRequirements);
  }

  const eventStaffPairs: { event: SofiaVoiceBookingEventRow; staffRows: SofiaVoiceBookingStaffRow[] }[] = [];
  for (const event of selectedEvents) {
    const staffRowsForEvent = await deps.listEligibleBookableStaffForEvent(input.orgId, event.id);
    eventStaffPairs.push({ event, staffRows: staffRowsForEvent });
  }
  const allStaffRows = eventStaffPairs.flatMap((pair) => pair.staffRows);
  if (!allStaffRows.length) {
    missingRequirements.push('No bookable staff with availability are available for Sofia voice booking.');
    return emptyOptions('sofia_voice_booking', missingRequirements);
  }

  const staffDisambiguation = getStaffDisambiguation(allStaffRows, input.preferredStaffName || null);
  if (staffDisambiguation) {
    return {
      ...emptyOptions('sofia_voice_booking', []),
      staffDisambiguation
    };
  }

  const searchDates = buildSearchDates({
    timezone: orgTimezone,
    preferredDate: input.preferredDate || null,
    preferredEndDate: input.preferredEndDate || null,
    preferredDateTime: input.preferredDateTime || null,
    horizonDays: input.horizonDays || null,
    now: input.now || new Date()
  });
  const options: SofiaVoiceBookingOption[] = [];
  const diagnostics: AvailabilitySlotsDiagnostics[] = [];
  const closestTimePreference = input.preferredTime && input.preferredTimeRelation === 'around'
    ? { timezone: orgTimezone, preferredTime: input.preferredTime }
    : null;
  const eventAvailabilityCache = new Map<string, SofiaVoiceEventAvailabilityRow[]>();

  for (const date of searchDates) {
    const optionCountBeforeDate = options.length;
    for (const eventStaffPair of eventStaffPairs) {
      const { event, staffRows } = eventStaffPair;
      const orderedStaff = orderStaffForVoiceBooking(staffRows, input.preferredStaffName || null);
      for (const staff of orderedStaff) {
        const slotResult = await deps.getAvailableSlots(
          input.orgId,
          staff.id,
          date,
          event.duration_minutes,
          event.id,
          input.excludeBookingId || null
        );
        diagnostics.push(slotResult.diagnostics);
        const eventAvailability = await getCachedSofiaVoiceEventAvailability({
          orgId: input.orgId,
          eventId: event.id,
          userId: staff.id,
          cache: eventAvailabilityCache,
          loader: deps.listSofiaVoiceEventAvailability
        });
        const eventFilteredSlots = filterSlotsByEventAvailability(slotResult.slots, {
          timezone: orgTimezone,
          date,
          eventAvailability
        });
        const filteredSlots = filterSlotsByPreference(eventFilteredSlots, {
          timezone: orgTimezone,
          preferredTime: input.preferredTime || null,
          preferredTimeRelation: input.preferredTimeRelation || null,
          preferredTimeWindow: input.preferredTimeWindow || null
        });
        logInfo(LOG_CONTEXT, 'voice.booking.availability_search.date_completed', {
          ...bookingServiceLogContext(input.orgId, input.observability, 'get_booking_options'),
          userId: staff.id,
          staffMemberId: staff.id,
          eventId: event.id,
          orgTimezone,
          requestedDate: date,
          preferredDate: input.preferredDate || null,
          preferredTime: input.preferredTime || null,
          preferredTimeRelation: input.preferredTimeRelation || null,
          preferredTimeWindow: input.preferredTimeWindow || null,
          staffAvailabilityWindows: slotResult.diagnostics.staffAvailabilityWindows,
          sofiaEventAvailabilityWindows: eventAvailability.map((row) => ({
            day_of_week: row.day_of_week,
            start_time: row.start_time,
            end_time: row.end_time
          })),
          allowSameDayBooking: slotResult.diagnostics.allowSameDayBooking,
          minBookingLeadTimeMinutes: slotResult.diagnostics.minBookingLeadTimeMinutes,
          generatedSlotCount: slotResult.diagnostics.generatedSlotCount,
          removedBySameDayDisabled: slotResult.diagnostics.removedBySameDayDisabled,
          removedByMinLeadTime: slotResult.diagnostics.removedByMinLeadTime,
          removedByExistingBookings: slotResult.diagnostics.removedByExistingBookings,
          removedByExternalCalendarBusy: slotResult.diagnostics.removedByExternalCalendarBusy,
          removedBySofiaEventAvailability: slotResult.slots.length - eventFilteredSlots.length,
          removedByTimePreference: eventFilteredSlots.length - filteredSlots.length,
          finalSlotCount: filteredSlots.length,
          firstOfferedSlotLocalTime: filteredSlots[0] ? formatSlotForVoice(filteredSlots[0].start_time, orgTimezone) : null
        });
        for (const slot of filteredSlots) {
          options.push(toSofiaVoiceBookingOption({
            staff,
            event,
            timezone: orgTimezone,
            startTime: slot.start_time,
            endTime: slot.end_time,
            orgId: input.orgId,
            callerPhone: input.callerPhone,
            issuedAt: input.tokenIssuedAt || new Date()
          }));
          if (options.length >= limit && !closestTimePreference) {
            return finalizeOptions(options, 'sofia_voice_booking', [], diagnostics, true, { limit });
          }
        }
      }
    }
    if (input.preferredDate && options.length > optionCountBeforeDate) {
      return finalizeOptions(
        options,
        'sofia_voice_booking',
        [],
        diagnostics,
        closestTimePreference ? hasExactPreferredTime(options, closestTimePreference) : true,
        { limit, closestTimePreference }
      );
    }
  }

  if (!options.length) {
    missingRequirements.push('No available appointment openings were found for Sofia voice booking staff.');
  }
  return finalizeOptions(
    options,
    'sofia_voice_booking',
    missingRequirements,
    diagnostics,
    closestTimePreference ? hasExactPreferredTime(options, closestTimePreference) : options.length > 0,
    { limit, closestTimePreference }
  );
}

export async function createSofiaVoiceBooking(
  input: CreateSofiaVoiceBookingInput
): Promise<CreateSofiaVoiceBookingResult> {
  const deps: CreateSofiaVoiceBookingDeps = {
    revalidateSelectedOption,
    resolveOrCreateCallerContact,
    ensureClientContact,
    createBooking: bookingService.createBooking.bind(bookingService),
    enqueueVoiceBookingConfirmationSmsJob,
    ...(input.deps || {})
  };
  const context = bookingServiceLogContext(input.orgId, input.observability, 'create_sofia_voice_booking');
  if (input.confirmationReceived !== true) {
    logInfo(LOG_CONTEXT, 'voice.booking.mutation.skipped', {
      ...context,
      status: 'skipped',
      reason: 'confirmation_missing'
    });
    const err = new Error('confirmationReceived must be true before creating a Sofia voice booking') as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'CONFIRMATION_REQUIRED';
    throw err;
  }
  if (!input.selectedOption?.staffMemberId || !input.selectedOption.eventId || !input.selectedOption.startTime) {
    logInfo(LOG_CONTEXT, 'voice.booking.mutation.skipped', {
      ...context,
      status: 'skipped',
      reason: 'missing_required_ids'
    });
    const err = new Error('selectedOption from get_booking_options is required') as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'SELECTED_OPTION_REQUIRED';
    throw err;
  }

  verifySofiaVoiceBookingOptionToken({
    orgId: input.orgId,
    callerPhone: input.callerPhone,
    selectedOption: input.selectedOption
  });
  const revalidateStartedAt = Date.now();
  await deps.revalidateSelectedOption(input.orgId, input.selectedOption);
  logInfo(LOG_CONTEXT, 'voice.booking.create.step_succeeded', {
    ...context,
    step: 'revalidate_selected_option',
    durationMs: Date.now() - revalidateStartedAt
  });
  const contactStartedAt = Date.now();
  const contact = await deps.resolveOrCreateCallerContact(input.orgId, input.callerPhone, input.contactId || null);
  const contactId = contact?.id || null;
  if (contact) {
    await deps.ensureClientContact(input.orgId, contact);
  }
  logInfo(LOG_CONTEXT, 'voice.booking.create.step_succeeded', {
    ...context,
    step: 'resolve_contact',
    durationMs: Date.now() - contactStartedAt,
    contactFound: Boolean(contactId)
  });

  const bookingStartedAt = Date.now();
  const booking = await deps.createBooking(input.orgId, {
    event_id: input.selectedOption.eventId,
    user_id: input.selectedOption.staffMemberId,
    contact_id: contactId,
    client_name: buildClientName(contact),
    client_email: contact?.email || '',
    client_phone: input.callerPhone,
    start_time: input.selectedOption.startTime,
    end_time: input.selectedOption.endTime,
    timezone: input.selectedOption.timezone,
    client_notes: null,
    internal_notes: [
      'source=sofia_voice',
      `voice_event=${input.selectedOption.eventName}`,
      `voice_staff=${input.selectedOption.staffMemberName}`
    ].join('\n'),
    custom_fields: {},
    booking_source: 'internal',
    override_availability: false,
    defer_side_effects: true,
    defer_side_effects_observability: observabilityToJson(input.observability)
  });
  logInfo(LOG_CONTEXT, 'voice.booking.create.step_succeeded', {
    ...context,
    step: 'create_booking',
    durationMs: Date.now() - bookingStartedAt,
    bookingId: booking.id
  });

  const enqueueStartedAt = Date.now();
  const smsJob = await deps.enqueueVoiceBookingConfirmationSmsJob({
    orgId: input.orgId,
    bookingId: booking.id,
    callerPhone: input.callerPhone,
    smsPhoneOverride: input.smsPhoneOverride || null,
    contactId,
    option: input.selectedOption,
    ...(input.observability !== undefined ? { observability: input.observability } : {})
  });
  logInfo(LOG_CONTEXT, 'voice.booking.create.step_succeeded', {
    ...context,
    step: 'enqueue_durable_jobs',
    durationMs: Date.now() - enqueueStartedAt,
    smsJobId: smsJob.id
  });

  return {
    bookingId: booking.id,
    startTime: input.selectedOption.startTime,
    staffMemberName: input.selectedOption.staffMemberName,
    timezone: input.selectedOption.timezone,
    smsSent: false,
    smsStatus: 'queued',
    smsQueued: true,
    contactId
  };
}

export async function lookupUpcomingVoiceBookings(
  input: LookupUpcomingVoiceBookingsInput
): Promise<VoiceBookingLookupSummary[]> {
  const deps: LookupUpcomingVoiceBookingsDeps = {
    findContactsByPhone: contactModel.findContactsByPhone,
    getUpcomingBookingsForVoiceCaller: bookingService.getUpcomingBookingsForVoiceCaller.bind(bookingService),
    ...(input.deps || {})
  };
  const contactMatches = await deps.findContactsByPhone(input.orgId, input.callerPhone) as ContactLike[];
  const contactIds = Array.from(new Set(contactMatches
    .filter((contact) => !contact.deleted_at && contact.id)
    .map((contact) => String(contact.id))));
  const bookings = await deps.getUpcomingBookingsForVoiceCaller({
    orgId: input.orgId,
    contactIds,
    phone: input.callerPhone,
    ...(input.now !== undefined ? { now: input.now } : {}),
    limit: input.limit || 3
  });
  return bookings.map(toVoiceBookingLookupSummary);
}

export async function cancelVoiceBooking(input: CancelVoiceBookingInput): Promise<MutateVoiceBookingResult> {
  const deps: CancelVoiceBookingDeps = {
    lookupUpcomingVoiceBookings,
    cancelBooking: bookingService.cancelBooking.bind(bookingService),
    enqueueVoiceBookingStatusSmsJob,
    ...(input.deps || {})
  };
  const context = bookingServiceLogContext(input.orgId, input.observability, 'cancel_voice_booking');
  const verified = await verifyCallerUpcomingBooking({
    orgId: input.orgId,
    callerPhone: input.callerPhone,
    bookingId: input.bookingId,
    ...(input.now !== undefined ? { now: input.now } : {}),
    lookupUpcomingVoiceBookings: deps.lookupUpcomingVoiceBookings
  });
  const startedAt = Date.now();
  const cancelled = await deps.cancelBooking(input.orgId, input.bookingId, input.reason || 'Cancelled by caller through Sofia voice', {
    actorType: 'system',
    actorUserId: null
  });
  logInfo(LOG_CONTEXT, 'voice.booking.cancel.succeeded', {
    ...context,
    durationMs: Date.now() - startedAt,
    bookingId: input.bookingId
  });
  const smsJob = await deps.enqueueVoiceBookingStatusSmsJob({
    orgId: input.orgId,
    bookingId: cancelled.id,
    callerPhone: input.callerPhone,
    action: 'cancelled',
    option: voiceBookingSummaryToSmsOption(verified),
    ...(input.observability !== undefined ? { observability: input.observability } : {})
  });
  return {
    ...verified,
    bookingId: cancelled.id,
    status: cancelled.status || verified.status,
    smsQueued: true,
    smsStatus: smsJob.status || 'queued'
  };
}

export async function rescheduleVoiceBooking(input: RescheduleVoiceBookingInput): Promise<MutateVoiceBookingResult> {
  const deps: RescheduleVoiceBookingDeps = {
    lookupUpcomingVoiceBookings,
    revalidateSelectedOption,
    updateBooking: bookingService.updateBooking.bind(bookingService),
    enqueueVoiceBookingStatusSmsJob,
    ...(input.deps || {})
  };
  const context = bookingServiceLogContext(input.orgId, input.observability, 'reschedule_voice_booking');
  if (input.confirmationReceived !== true) {
    const err = new Error('confirmationReceived must be true before rescheduling a Sofia voice booking') as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'CONFIRMATION_REQUIRED';
    throw err;
  }
  await verifyCallerUpcomingBooking({
    orgId: input.orgId,
    callerPhone: input.callerPhone,
    bookingId: input.bookingId,
    ...(input.now !== undefined ? { now: input.now } : {}),
    lookupUpcomingVoiceBookings: deps.lookupUpcomingVoiceBookings
  });
  verifySofiaVoiceBookingOptionToken({
    orgId: input.orgId,
    callerPhone: input.callerPhone,
    selectedOption: input.selectedOption
  });
  const revalidateStartedAt = Date.now();
  await deps.revalidateSelectedOption(input.orgId, input.selectedOption, input.bookingId);
  logInfo(LOG_CONTEXT, 'voice.booking.reschedule.step_succeeded', {
    ...context,
    step: 'revalidate_selected_option',
    durationMs: Date.now() - revalidateStartedAt,
    bookingId: input.bookingId
  });
  const updateStartedAt = Date.now();
  const updated = await deps.updateBooking(input.orgId, input.bookingId, {
    event_id: input.selectedOption.eventId,
    user_id: input.selectedOption.staffMemberId,
    start_time: input.selectedOption.startTime,
    end_time: input.selectedOption.endTime,
    timezone: input.selectedOption.timezone
  }, {
    actorType: 'system',
    actorUserId: null
  });
  logInfo(LOG_CONTEXT, 'voice.booking.reschedule.succeeded', {
    ...context,
    durationMs: Date.now() - updateStartedAt,
    bookingId: input.bookingId
  });
  const result = toMutateVoiceBookingResult(updated);
  const smsJob = await deps.enqueueVoiceBookingStatusSmsJob({
    orgId: input.orgId,
    bookingId: result.bookingId,
    callerPhone: input.callerPhone,
    action: 'rescheduled',
    option: {
      staffMemberName: input.selectedOption.staffMemberName,
      startTime: input.selectedOption.startTime,
      timezone: input.selectedOption.timezone
    },
    ...(input.observability !== undefined ? { observability: input.observability } : {})
  });
  return {
    ...result,
    smsQueued: true,
    smsStatus: smsJob.status || 'queued'
  };
}

function toVoiceBookingLookupSummary(booking: {
  id: string;
  start_time: string | Date;
  end_time?: string | Date | null;
  timezone: string;
  event_name?: string | null;
  service_name?: string | null;
  status?: string | null;
  user_first_name?: string | null;
  user_last_name?: string | null;
  user_email?: string | null;
}): VoiceBookingLookupSummary {
  return {
    bookingId: booking.id,
    startTime: booking.start_time instanceof Date ? booking.start_time.toISOString() : String(booking.start_time),
    endTime: booking.end_time instanceof Date ? booking.end_time.toISOString() : booking.end_time ? String(booking.end_time) : null,
    timezone: booking.timezone,
    staffMemberName: [booking.user_first_name, booking.user_last_name].filter(Boolean).join(' ').trim() || null,
    eventName: booking.event_name || booking.service_name || null,
    status: booking.status || null
  };
}

function toMutateVoiceBookingResult(booking: {
  id: string;
  start_time: string | Date;
  end_time?: string | Date | null;
  timezone: string;
  status?: string | null;
  event_name?: string | null;
  service_name?: string | null;
  user_first_name?: string | null;
  user_last_name?: string | null;
}): MutateVoiceBookingResult {
  return {
    bookingId: booking.id,
    startTime: booking.start_time instanceof Date ? booking.start_time.toISOString() : String(booking.start_time),
    endTime: booking.end_time instanceof Date ? booking.end_time.toISOString() : booking.end_time ? String(booking.end_time) : null,
    timezone: booking.timezone,
    staffMemberName: [booking.user_first_name, booking.user_last_name].filter(Boolean).join(' ').trim() || null,
    eventName: booking.event_name || booking.service_name || null,
    status: booking.status || null
  };
}

function voiceBookingSummaryToSmsOption(summary: VoiceBookingLookupSummary): {
  staffMemberName: string;
  startTime: string;
  timezone: string;
} {
  return {
    staffMemberName: summary.staffMemberName || 'the office',
    startTime: summary.startTime,
    timezone: summary.timezone
  };
}

async function verifyCallerUpcomingBooking(input: {
  orgId: string;
  callerPhone: string;
  bookingId: string;
  now?: Date;
  lookupUpcomingVoiceBookings: typeof lookupUpcomingVoiceBookings;
}): Promise<VoiceBookingLookupSummary> {
  const bookings = await input.lookupUpcomingVoiceBookings({
    orgId: input.orgId,
    callerPhone: input.callerPhone,
    ...(input.now !== undefined ? { now: input.now } : {}),
    limit: 10
  });
  const match = bookings.find((booking) => booking.bookingId === input.bookingId) || null;
  if (!match) {
    const err = new Error('Booking was not found for this caller or is not eligible for voice mutation') as Error & { status?: number; code?: string };
    err.status = 404;
    err.code = 'VOICE_BOOKING_NOT_MUTABLE';
    throw err;
  }
  if (isTerminalVoiceBookingStatus(match.status)) {
    const err = new Error('Terminal bookings cannot be changed by voice') as Error & { status?: number; code?: string };
    err.status = 409;
    err.code = 'VOICE_BOOKING_TERMINAL';
    throw err;
  }
  return match;
}

function isTerminalVoiceBookingStatus(status: string | null): boolean {
  return ['cancelled', 'completed', 'no_show', 'expired'].includes(String(status || '').toLowerCase());
}

function observabilityToJson(value: SofiaVoiceBookingObservability | undefined): JsonObject {
  return {
    callId: value?.callId || null,
    sessionId: value?.sessionId || null,
    turnId: value?.turnId || null,
    dialogId: value?.dialogId || null
  };
}

function toSofiaVoiceBookingOption(input: {
  staff: SofiaVoiceBookingStaffRow;
  event: SofiaVoiceBookingEventRow;
  timezone: string;
  startTime: string;
  endTime: string;
  orgId: string;
  callerPhone: string;
  issuedAt: Date;
}): SofiaVoiceBookingOption {
  const staffMemberName = staffName(input.staff);
  const optionWithoutToken = {
    staffMemberId: input.staff.id,
    staffMemberName,
    eventId: input.event.id,
    eventName: input.event.name,
    startTime: input.startTime,
    endTime: input.endTime,
    timezone: input.timezone,
    durationMinutes: input.event.duration_minutes,
    displayText: isGenericSofiaVoiceEventName(input.event.name)
      ? `${formatSlotForVoice(input.startTime, input.timezone)} with ${staffMemberName}`
      : `${input.event.name} on ${formatSlotForVoice(input.startTime, input.timezone)} with ${staffMemberName}`
  };
  return {
    ...optionWithoutToken,
    optionToken: createSofiaVoiceBookingOptionToken({
      orgId: input.orgId,
      callerPhone: input.callerPhone,
      selectedOption: optionWithoutToken,
      issuedAt: input.issuedAt
    })
  };
}

async function revalidateSelectedOption(
  orgId: string,
  selectedOption: SofiaVoiceBookingOption,
  excludeBookingId: string | null = null
): Promise<void> {
  const date = dateKeyInTimezone(selectedOption.startTime, selectedOption.timezone);
  const slots = await bookingService.getAvailableSlots(
    orgId,
    selectedOption.staffMemberId,
    date,
    selectedOption.durationMinutes,
    selectedOption.eventId,
    excludeBookingId
  );
  const eventAvailability = await listSofiaVoiceEventAvailability(
    orgId,
    selectedOption.eventId,
    selectedOption.staffMemberId
  );
  const filteredSlots = filterSlotsByEventAvailability(slots, {
    timezone: selectedOption.timezone,
    date,
    eventAvailability
  });
  const stillAvailable = filteredSlots.some((slot) =>
    new Date(slot.start_time).getTime() === new Date(selectedOption.startTime).getTime()
    && new Date(slot.end_time).getTime() === new Date(selectedOption.endTime).getTime()
  );
  if (!stillAvailable) {
    const err = new Error('The selected appointment slot is no longer available') as Error & { status?: number; code?: string };
    err.status = 409;
    err.code = 'SLOT_UNAVAILABLE';
    throw err;
  }
}

async function resolveOrCreateCallerContact(orgId: string, callerPhone: string, contactId: string | null): Promise<ContactLike | null> {
  if (contactId) {
    const existing = await contactModel.findContactById(contactId, orgId) as ContactLike | null;
    if (existing && !existing.deleted_at) return existing;
  }
  const matches = await contactModel.findContactsByPhone(orgId, callerPhone) as ContactLike[];
  const active = matches.filter((contact) => !contact.deleted_at);
  if (active.length === 1) {
    const activeContact = active[0];
    if (!activeContact) {
      throw new Error('Expected active caller contact but none was returned');
    }
    return activeContact;
  }
  if (active.length > 1) {
    const err = new Error('Multiple active contacts match this caller phone') as Error & { status?: number; code?: string };
    err.status = 409;
    err.code = 'CALLER_PHONE_AMBIGUOUS';
    throw err;
  }
  const created = await contactModel.createContact(orgId, {
    first_name: '',
    last_name: '',
    phone: callerPhone,
    email: null,
    contact_type: ['client'],
    source: 'sofia_voice'
  } as JsonObject) as ContactLike | null;
  return created;
}

async function ensureClientContact(orgId: string, contact: ContactLike): Promise<void> {
  if (!contact.id) return;
  await clientContactModel.ensureByContactId(contact.id, orgId);
}

function bookingServiceLogContext(
  orgId: string,
  observability: SofiaVoiceBookingObservability | null | undefined,
  action: string
) {
  return {
    orgId,
    callId: observability?.callId || null,
    sessionId: observability?.sessionId || null,
    turnId: observability?.turnId || null,
    dialogId: observability?.dialogId || null,
    action,
    tool: action
  };
}

function finalizeOptions(
  options: SofiaVoiceBookingOption[],
  source: string,
  missingRequirements: string[] = [],
  diagnostics: AvailabilitySlotsDiagnostics[] = [],
  preferenceMatched = true,
  sortOptions: {
    limit?: number;
    closestTimePreference?: { timezone: string; preferredTime: string } | null;
  } = {}
): SofiaVoiceBookingOptionsResult {
  const preferredMinutes = sortOptions.closestTimePreference
    ? timeToMinutes(sortOptions.closestTimePreference.preferredTime)
    : null;
  const sorted = [...options].sort((a, b) => {
    if (sortOptions.closestTimePreference && preferredMinutes !== null) {
      const aDistance = Math.abs(localSlotStartMinutes(a.startTime, sortOptions.closestTimePreference.timezone) - preferredMinutes);
      const bDistance = Math.abs(localSlotStartMinutes(b.startTime, sortOptions.closestTimePreference.timezone) - preferredMinutes);
      if (aDistance !== bDistance) return aDistance - bDistance;
    }
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  }).slice(0, sortOptions.limit || options.length);
  return {
    options: sorted,
    defaultOption: sorted[0] || null,
    source,
    missingRequirements,
    eventSelectionRequired: false,
    diagnostics,
    preferenceMatched
  };
}

function hasExactPreferredTime(
  options: SofiaVoiceBookingOption[],
  input: { timezone: string; preferredTime: string }
): boolean {
  const preferredMinutes = timeToMinutes(input.preferredTime);
  return options.some((option) => localSlotStartMinutes(option.startTime, input.timezone) === preferredMinutes);
}

function emptyOptions(source: string, missingRequirements: string[]): SofiaVoiceBookingOptionsResult {
  return {
    options: [],
    defaultOption: null,
    source,
    missingRequirements,
    eventSelectionRequired: false,
    staffDisambiguation: null
  };
}

function toEventSelection(event: SofiaVoiceBookingEventRow): SofiaVoiceBookingEventSelection {
  return {
    eventId: event.id,
    eventName: event.name_en || event.name_es || event.name || 'Appointment'
  };
}

function eventSelectionPromptForEvents(events: SofiaVoiceBookingEventRow[]): string {
  const purposes = new Set(events.map((event) => event.system_purpose || ''));
  if (purposes.size === 1 && purposes.has('sofia_voice_booking_location')) {
    return 'Ask the caller which location they prefer. Do not say there is no availability. After the caller chooses, call get_available_slots again with selectedEventId from availableEvents.';
  }
  if (purposes.size === 1 && purposes.has('sofia_voice_booking')) {
    return 'Ask the caller which appointment type they prefer. Do not say there is no availability. After the caller chooses, call get_available_slots again with selectedEventId from availableEvents.';
  }
  return 'Ask the caller which option they would like. Do not say there is no availability. After the caller chooses, call get_available_slots again with selectedEventId from availableEvents.';
}

function normalizeLimit(value: number | null | undefined): number {
  const parsed = Number(value || DEFAULT_OPTION_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_OPTION_LIMIT;
  return Math.min(Math.floor(parsed), 5);
}

async function getCachedSofiaVoiceEventAvailability(input: {
  orgId: string;
  eventId: string;
  userId: string;
  cache: Map<string, SofiaVoiceEventAvailabilityRow[]>;
  loader: typeof listSofiaVoiceEventAvailability;
}): Promise<SofiaVoiceEventAvailabilityRow[]> {
  const key = `${input.eventId}:${input.userId}`;
  const cached = input.cache.get(key);
  if (cached) return cached;
  const rows = await input.loader(input.orgId, input.eventId, input.userId);
  input.cache.set(key, rows);
  return rows;
}

function buildClientName(contact: ContactLike | null): string {
  if (!contact) return '';
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
}
