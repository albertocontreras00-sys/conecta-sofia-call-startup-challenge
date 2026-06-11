import type {
  SofiaActiveBookingSummary,
  SofiaVoiceBookingOption
} from '../../services/voice/voiceSessionTypes.ts';

export function formatBookingSummaryForVoice(summary: SofiaActiveBookingSummary, spanish: boolean): string {
  const parts = [
    formatSlotForLookup(summary.startTime, summary.timezone),
    summary.staffMemberName ? (spanish ? `con ${summary.staffMemberName}` : `with ${summary.staffMemberName}`) : null,
    summary.eventName ? (spanish ? `para ${summary.eventName}` : `for ${summary.eventName}`) : null
  ].filter(Boolean);
  return parts.join(' ');
}

export function formatMultipleBookingSummaries(summaries: SofiaActiveBookingSummary[], spanish: boolean): string {
  return summaries.map((summary, index) =>
    `${index + 1}. ${formatBookingSummaryForVoice(summary, spanish)}`
  ).join('; ');
}

export function formatSlotForLookup(startTime: string, timezone: string): string {
  const date = new Date(startTime);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(date);
  return `${day} at ${formatTimeForLookup(date, timezone)} ${formatTimezoneForLookup(timezone)}`;
}

export function formatAlternateOptions(options: SofiaVoiceBookingOption[]): string {
  const firstOption = options[0];
  if (!firstOption) return '';
  if (options.length === 1) return firstOption.displayText;
  const secondOption = options[1];
  if (!secondOption) return firstOption.displayText;
  return `${firstOption.displayText}, or ${secondOption.displayText}`;
}

export function formatStaffMatchCount(count: number, spanish = false): string {
  if (spanish) {
    if (count === 2) return 'dos personas';
    if (count === 3) return 'tres personas';
    return `${count} personas`;
  }
  if (count === 2) return 'two people';
  if (count === 3) return 'three people';
  return `${count} people`;
}

export function formatStaffNames(names: string[], spanish = false): string {
  const clean = names.filter(Boolean);
  if (clean.length <= 1) return clean[0] || (spanish ? 'esa persona' : 'that staff member');
  if (clean.length === 2) return spanish ? `${clean[0]} o ${clean[1]}` : `${clean[0]} or ${clean[1]}`;
  if (spanish) return `${clean.slice(0, -1).join(', ')}, o ${clean[clean.length - 1]}`;
  return `${clean.slice(0, -1).join(', ')}, or ${clean[clean.length - 1]}`;
}

function formatTimeForLookup(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function formatTimezoneForLookup(timezone: string): string {
  if (timezone === 'America/Los_Angeles') return 'Pacific Time';
  if (timezone === 'America/Denver') return 'Mountain Time';
  if (timezone === 'America/Chicago') return 'Central Time';
  if (timezone === 'America/New_York') return 'Eastern Time';
  return timezone;
}
