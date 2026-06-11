import { sql } from '../db/neon.js';
import { requiredRow } from '../utils/strictTyping.ts';

const SOFIA_VOICE_BOOKING_SYSTEM_PURPOSE = 'sofia_voice_booking';

export type SofiaVoiceBookingEventRow = {
  id: string;
  org_id: string;
  name: string;
  name_en: string | null;
  name_es: string | null;
  duration_minutes: number;
  system_purpose: string | null;
};

export type SofiaVoiceEventAvailabilityRow = {
  id: string;
  org_id: string;
  event_id: string;
  user_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
};

export type SofiaVoiceBookingStaffRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  booking_event_ids: string[] | null;
  is_owner: boolean;
};

export async function findActiveSofiaVoiceBookingEvent(orgId: string): Promise<SofiaVoiceBookingEventRow | null> {
  const rows = await sql<SofiaVoiceBookingEventRow>`
    SELECT
      id,
      org_id,
      COALESCE(NULLIF(TRIM(name_en), ''), NULLIF(TRIM(name_es), ''), NULLIF(TRIM(name), '')) AS name,
      name_en,
      name_es,
      duration_minutes,
      system_purpose
    FROM events
    WHERE org_id = ${orgId}::uuid
      AND is_active = true
      AND deleted_at IS NULL
      AND system_purpose = ${SOFIA_VOICE_BOOKING_SYSTEM_PURPOSE}
      AND is_system = true
      AND created_by_type = 'system'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listActiveSofiaVoiceBookingEvents(orgId: string): Promise<SofiaVoiceBookingEventRow[]> {
  return sql<SofiaVoiceBookingEventRow>`
    SELECT
      id,
      org_id,
      COALESCE(NULLIF(TRIM(name_en), ''), NULLIF(TRIM(name_es), ''), NULLIF(TRIM(name), '')) AS name,
      name_en,
      name_es,
      duration_minutes,
      system_purpose
    FROM events
    WHERE org_id = ${orgId}::uuid
      AND is_active = true
      AND deleted_at IS NULL
      AND system_purpose IN (${SOFIA_VOICE_BOOKING_SYSTEM_PURPOSE}, 'sofia_voice_booking_location')
      AND is_system = true
      AND created_by_type = 'system'
    ORDER BY
      CASE system_purpose
        WHEN ${SOFIA_VOICE_BOOKING_SYSTEM_PURPOSE} THEN 0
        ELSE 1
      END,
      created_at ASC,
      id ASC
  `;
}

export async function createSofiaVoiceBookingEvent(
  orgId: string,
  durationMinutes: number
): Promise<SofiaVoiceBookingEventRow> {
  const rows = await sql<SofiaVoiceBookingEventRow>`
    INSERT INTO events (
      org_id,
      name,
      name_en,
      name_es,
      description,
      description_en,
      description_es,
      duration_minutes,
      is_active,
      create_zoom_meeting,
      system_purpose,
      is_system,
      created_by_type
    )
    VALUES (
      ${orgId}::uuid,
      'Sofia Appointment',
      'Sofia Appointment',
      'Cita con Sofia',
      'System-managed appointment type for Sofia voice booking.',
      'System-managed appointment type for Sofia voice booking.',
      'Tipo de cita administrado por el sistema para reservas de voz de Sofia.',
      ${durationMinutes},
      true,
      false,
      ${SOFIA_VOICE_BOOKING_SYSTEM_PURPOSE},
      true,
      'system'
    )
    RETURNING
      id,
      org_id,
      COALESCE(NULLIF(TRIM(name_en), ''), NULLIF(TRIM(name_es), ''), NULLIF(TRIM(name), '')) AS name,
      name_en,
      name_es,
      duration_minutes,
      system_purpose
  `;
  return requiredRow(rows[0], 'Sofia voice booking event create did not return a row');
}

export async function listEligibleBookableStaffForSofia(orgId: string): Promise<SofiaVoiceBookingStaffRow[]> {
  return sql<SofiaVoiceBookingStaffRow>`
    SELECT
      u.id,
      u.first_name,
      u.last_name,
      u.email,
      u.booking_event_ids,
      EXISTS (
        SELECT 1
        FROM membership owner_m
        WHERE owner_m.org_id = u.org_id
          AND owner_m.user_id = u.id
          AND owner_m.is_active = true
          AND owner_m.role = 'owner'
      ) AS is_owner
    FROM users u
    WHERE u.org_id = ${orgId}::uuid
      AND u.firebase_uid IS NOT NULL
      AND u.deleted_at IS NULL
      AND u.is_bookable = true
      AND EXISTS (
        SELECT 1
        FROM membership m
        WHERE m.user_id = u.id
          AND m.org_id = u.org_id
          AND m.is_active = true
      )
      AND EXISTS (
        SELECT 1
        FROM availability a
        WHERE a.org_id = u.org_id
          AND a.user_id = u.id
      )
    ORDER BY is_owner DESC, u.created_at ASC, u.first_name ASC, u.last_name ASC
  `;
}

export async function assignBookingEventToStaff(
  orgId: string,
  eventId: string,
  staffIds: string[]
): Promise<void> {
  if (!staffIds.length) return;

  await sql`
    UPDATE users
    SET
      booking_event_ids = CASE
        WHEN booking_event_ids IS NULL THEN ARRAY[${eventId}::uuid]
        WHEN ${eventId}::uuid = ANY(booking_event_ids) THEN booking_event_ids
        ELSE booking_event_ids || ${eventId}::uuid
      END,
      updated_at = NOW()
    WHERE org_id = ${orgId}::uuid
      AND id = ANY(${staffIds}::uuid[])
      AND is_bookable = true
      AND deleted_at IS NULL
  `;
}

export async function listEligibleBookableStaffForEvent(
  orgId: string,
  eventId: string
): Promise<SofiaVoiceBookingStaffRow[]> {
  return sql<SofiaVoiceBookingStaffRow>`
    SELECT
      u.id,
      u.first_name,
      u.last_name,
      u.email,
      u.booking_event_ids,
      EXISTS (
        SELECT 1
        FROM membership owner_m
        WHERE owner_m.org_id = u.org_id
          AND owner_m.user_id = u.id
          AND owner_m.is_active = true
          AND owner_m.role = 'owner'
      ) AS is_owner
    FROM users u
    WHERE u.org_id = ${orgId}::uuid
      AND u.firebase_uid IS NOT NULL
      AND u.deleted_at IS NULL
      AND u.is_bookable = true
      AND u.booking_event_ids IS NOT NULL
      AND ${eventId}::uuid = ANY(u.booking_event_ids)
      AND EXISTS (
        SELECT 1
        FROM membership m
        WHERE m.user_id = u.id
          AND m.org_id = u.org_id
          AND m.is_active = true
      )
      AND EXISTS (
        SELECT 1
        FROM availability a
        WHERE a.org_id = u.org_id
          AND a.user_id = u.id
      )
    ORDER BY is_owner DESC, u.created_at ASC, u.first_name ASC, u.last_name ASC
  `;
}

export async function getOrgTimezoneForSofiaVoiceBooking(orgId: string): Promise<string | null> {
  const rows = await sql<{ timezone: string | null }>`
    SELECT timezone
    FROM org
    WHERE id = ${orgId}::uuid
    LIMIT 1
  `;
  return rows[0]?.timezone || null;
}

export async function listSofiaVoiceEventAvailability(
  orgId: string,
  eventId: string,
  userId: string
): Promise<SofiaVoiceEventAvailabilityRow[]> {
  return sql<SofiaVoiceEventAvailabilityRow>`
    SELECT
      id,
      org_id,
      event_id,
      user_id,
      day_of_week,
      start_time,
      end_time
    FROM sofia_voice_event_availability
    WHERE org_id = ${orgId}::uuid
      AND event_id = ${eventId}::uuid
      AND user_id = ${userId}::uuid
    ORDER BY day_of_week ASC, start_time ASC
  `;
}
