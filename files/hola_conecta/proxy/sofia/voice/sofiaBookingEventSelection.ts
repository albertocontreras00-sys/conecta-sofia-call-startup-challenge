import type { SofiaVoiceBookingEventSelection } from '../../services/voice/voiceSessionTypes.ts';

export function normalizeBookingSelectionText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function formatVoiceList(values: string[], spanish: boolean): string {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} ${spanish ? 'y' : 'and'} ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, ${spanish ? 'y' : 'and'} ${values[values.length - 1]}`;
}

export function resolveSofiaEventSelection(
  transcript: string,
  events: SofiaVoiceBookingEventSelection[]
): SofiaVoiceBookingEventSelection | null {
  if (!events.length) return null;
  const normalizedTranscript = normalizeBookingSelectionText(transcript);
  if (!normalizedTranscript) return null;

  for (const event of events) {
    const eventName = normalizeBookingSelectionText(event.eventName);
    if (eventName && normalizedTranscript.includes(eventName)) {
      return event;
    }
    const distinctiveTokens = eventName
      .split(' ')
      .filter((token) => token.length >= 3 && token !== 'office' && token !== 'appointment');
    if (distinctiveTokens.some((token) => normalizedTranscript.includes(token))) {
      return event;
    }
  }

  const ordinalMatch = normalizedTranscript.match(/\b(first|one|1|second|two|2|third|three|3)\b/);
  if (!ordinalMatch) return null;
  const ordinal = ordinalMatch[1];
  const index = ordinal === 'first' || ordinal === 'one' || ordinal === '1'
    ? 0
    : ordinal === 'second' || ordinal === 'two' || ordinal === '2'
      ? 1
      : 2;
  return events[index] || null;
}

export function buildEventSelectionPrompt(events: SofiaVoiceBookingEventSelection[], spanish: boolean): string {
  const names = formatVoiceList(events.map((event) => event.eventName), spanish);
  return spanish
    ? `¿Qué oficina prefiere? Tenemos ${names}.`
    : `Which office would you prefer? We have ${names}.`;
}
