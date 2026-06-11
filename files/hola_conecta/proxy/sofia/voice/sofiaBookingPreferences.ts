import type {
  BookingIntentState,
  SofiaVoiceBookingOption,
  SofiaPreferredTimeRelation,
  SofiaPreferredTimeWindow
} from '../../services/voice/voiceSessionTypes.ts';

export type BookingPreferenceUpdate = {
  preferredDate: string | null;
  preferredTime: string | null;
  preferredTimeRelation: SofiaPreferredTimeRelation | null;
  preferredTimeWindow: SofiaPreferredTimeWindow | null;
  preferredDateTime: string | null;
};

export function hasPreferenceUpdate(update: BookingPreferenceUpdate): boolean {
  return Boolean(update.preferredDate || update.preferredTime || update.preferredTimeRelation || update.preferredTimeWindow || update.preferredDateTime);
}

export function extractBookingPreferenceUpdate(transcript: string, now: Date): BookingPreferenceUpdate {
  const lower = transcript.toLowerCase();
  const explicitDate = lower.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const weekdayDate = findWeekdayDate(lower, now);
  const tomorrowRequested = /\btomorrow\b/.test(lower)
    || (/\bma[nñ]ana\b/.test(lower) && !/\ben la ma[nñ]ana\b/.test(lower));
  const date = explicitDate?.[1] || (tomorrowRequested ? offsetDate(now, 1) : weekdayDate);
  const relation = extractPreferredTimeRelation(lower);
  const preferredTimeWindow = extractPreferredTimeWindow(lower);
  const preferredTime = extractPreferredTime(lower, relation, preferredTimeWindow);
  const preferredDateTime = date && preferredTime ? `${date}T${preferredTime}` : date;
  return {
    preferredDate: date,
    preferredTime,
    preferredTimeRelation: preferredTime ? relation || 'around' : null,
    preferredTimeWindow,
    preferredDateTime
  };
}

export function applyPreferenceUpdate(state: BookingIntentState, update: BookingPreferenceUpdate): void {
  if (update.preferredDate) state.preferredDate = update.preferredDate;
  if (update.preferredTime) state.preferredTime = update.preferredTime;
  if (update.preferredTimeRelation) state.preferredTimeRelation = update.preferredTimeRelation;
  if (update.preferredTimeWindow) state.preferredTimeWindow = update.preferredTimeWindow;
  if (update.preferredDateTime) state.preferredDateTime = update.preferredDateTime;
}

export function applyRelativePreferenceUpdate(
  update: BookingPreferenceUpdate,
  lower: string,
  selectedOption: SofiaVoiceBookingOption | null
): BookingPreferenceUpdate {
  if (update.preferredTime || !selectedOption) return update;
  if (!/\b(later|later in the day|something later|anything later|otra hora|m[aá]s tarde)\b/i.test(lower)) return update;
  const selectedDate = dateKeyInTimezone(selectedOption.startTime, selectedOption.timezone);
  const selectedMinutes = localSlotStartMinutes(selectedOption.startTime, selectedOption.timezone);
  const laterMinutes = Math.min(selectedMinutes + 30, (23 * 60) + 59);
  const preferredTime = minutesToTime(laterMinutes);
  return {
    preferredDate: update.preferredDate || selectedDate,
    preferredTime,
    preferredTimeRelation: 'at_or_after',
    preferredTimeWindow: update.preferredTimeWindow,
    preferredDateTime: `${update.preferredDate || selectedDate}T${preferredTime}`
  };
}

export function hasStructuredPreference(state: BookingIntentState): boolean {
  return Boolean(state.preferredDate || state.preferredTime || state.preferredTimeWindow || state.preferredDateTime);
}

function extractPreferredTimeRelation(lower: string): SofiaPreferredTimeRelation | null {
  if (/\b(after|later than|at or after|despu[eé]s de)\b/.test(lower)) return 'at_or_after';
  if (/\b(before|earlier than|at or before|antes de|antes del)\b/.test(lower)) return 'at_or_before';
  if (/\b(around|about|close to|cerca de)\b/.test(lower)) return 'around';
  return null;
}

function extractPreferredTimeWindow(lower: string): SofiaPreferredTimeWindow | null {
  if (/\b(morning|in the morning|en la ma[nñ]ana)\b/.test(lower)) return 'morning';
  if (/\b(afternoon|in the afternoon|en la tarde)\b/.test(lower)) return 'afternoon';
  if (/\b(evening|later in the day|en la noche)\b/.test(lower)) return 'evening';
  return null;
}

function extractPreferredTime(
  lower: string,
  relation: SofiaPreferredTimeRelation | null,
  window: SofiaPreferredTimeWindow | null
): string | null {
  if (/\b(noon|mediod[ií]a)\b/.test(lower)) return '12:00';
  if (/\bdespu[eé]s de la una\b/.test(lower)) return '13:00';
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (timeMatch) {
    const hour = timeMatch[1];
    const meridiem = timeMatch[3];
    if (!hour || !meridiem) return null;
    return normalizeClockTime(hour, timeMatch[2] || '00', meridiem);
  }
  const hourOnly = lower.match(/\b(?:after|before|around|about|despu[eé]s de|antes de|cerca de)\s+(\d{1,2})(?:\b|$)/i);
  if (hourOnly?.[1]) {
    let hour = Number(hourOnly[1]);
    if (hour >= 1 && hour <= 7 && (relation === 'at_or_after' || window === 'afternoon' || window === 'evening')) {
      hour += 12;
    }
    return `${String(hour).padStart(2, '0')}:00`;
  }
  return null;
}

function normalizeClockTime(hourValue: string, minuteValue: string, meridiemValue: string): string {
  let hour = Number(hourValue);
  const minute = Number(minuteValue);
  const meridiem = meridiemValue.toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function findWeekdayDate(lower: string, now: Date): string | null {
  const weekdays = [
    ['sunday', 'domingo'],
    ['monday', 'lunes'],
    ['tuesday', 'martes'],
    ['wednesday', 'miercoles', 'miércoles'],
    ['thursday', 'jueves'],
    ['friday', 'viernes'],
    ['saturday', 'sabado', 'sábado']
  ];
  const target = weekdays.findIndex((aliases) =>
    aliases.some((day) => new RegExp(`\\b${day}\\b`).test(lower))
  );
  if (target < 0) return null;
  const current = now.getUTCDay();
  const daysAhead = (target - current + 7) % 7 || 7;
  return offsetDate(now, daysAhead);
}

function offsetDate(now: Date, days: number): string {
  const next = new Date(now.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function dateKeyInTimezone(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`;
}

function localSlotStartMinutes(value: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0');
  return ((hour === 24 ? 0 : hour) * 60) + minute;
}

function minutesToTime(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
