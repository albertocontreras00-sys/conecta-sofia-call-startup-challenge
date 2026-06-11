export function isBookingIntent(text: string): boolean {
  return /\b(book|schedule|appointment|appointments|appt|appts|availability|available|calendar|meeting|opening|openings|slot|slots|cita|citas|agendar)\b/i.test(text);
}

export function isAppointmentLookupIntent(text: string): boolean {
  return /\b(when is my appointment|do i have (an|any)?\s*(appointment|appointments|appt|appts)?|do we have (an|any)?\s*(appointment|appointments|appt|appts)?|any (appointment|appointments|appt|appts)|what (appointment|appointments|appt|appts) do i have|what time is my appointment|my (appointment|appointments|appt|appts)|upcoming( appointment| appointments| appt| appts)?|(appointment|appointments|appt|appts).{0,24}coming up|coming up.{0,24}(appointment|appointments|appt|appts)|anything scheduled|on my calendar|cu[aá]ndo es mi cita|tengo cita|tengo alguna cita|mi cita|mis citas|a qu[eé] hora es mi cita)\b/i.test(text);
}

export function isCancellationIntent(text: string): boolean {
  return /\b(cancel it|cancel my appointment|cancel my booking|i need to cancel|i can'?t make it|cancela mi cita|quiero cancelar|no puedo ir)\b/i.test(text);
}

export function isRescheduleIntent(text: string): boolean {
  return /\b(reschedule it|reschedule my appointment|move my appointment|change my appointment|change it to|move it to|can i change it|can we do|do you have anything later|hay algo m[aá]s tarde|quiero cambiar mi cita|puedo mover mi cita|mover mi cita|cambiar mi cita)\b/i.test(text);
}

export function isConfirmation(text: string): boolean {
  return /(^|\s)(yes|yeah|yep|ok|okay|sure|book it|that works|send it|sí|si|perfecto|dale|m[aá]ndalo|env[ií]alo)(\s|[.,!?]|$)/i.test(text);
}

export function isRejection(text: string): boolean {
  return /(^|\s)(no|nope|cancel|not that one|another time|different time|different day|different person|not that|doesn'?t work|do not|don't|another|something else)(\s|[.,!?]|$)/i.test(text);
}

export function isCorrection(text: string): boolean {
  return /\b(actually|make it|change it|instead|can we do|how about|no,\s*i meant)\b/i.test(text);
}

export function isBookingRefinement(text: string): boolean {
  return /\b(what about|anything|after|before|later|earlier|morning|afternoon|evening|another time|different time|different day|something later|not that one|wednesday|thursday|friday|monday|tuesday|saturday|sunday|tomorrow|despu[eé]s|antes|tarde|ma[nñ]ana|mediod[ií]a)\b/i.test(text);
}

export function isEndIntent(text: string): boolean {
  return /(^|\s)(no|nope|that'?s all|thank you|thanks|goodbye|bye|all set|nothing else|no gracias|gracias|adiós|adios)(\s|[.,!?]|$)/i.test(text);
}

export function extractPhoneNumber(transcript: string): string | null {
  const digits = transcript.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function extractPreferredStaffName(transcript: string): string | null {
  const match = transcript.match(/\b(?:with|want|prefer|see|con)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)?)\b/);
  if (!match?.[1]) return null;
  const value = match[1].trim();
  if (/^(an|a|the|appointment|to|book|schedule|una|un|la|el|cita|agendar|reservar)$/i.test(value)) return null;
  return value;
}
