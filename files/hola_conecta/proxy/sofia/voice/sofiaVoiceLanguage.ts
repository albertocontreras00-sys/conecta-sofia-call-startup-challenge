import type { SofiaVoiceLanguage } from '../../services/voice/voiceSessionTypes.ts';

export function normalizeVoiceLanguage(value: string | null | undefined): SofiaVoiceLanguage {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'es' || normalized.startsWith('es-') || normalized === 'spanish' || normalized === 'español') {
    return 'es';
  }
  return 'en';
}

export function isSpanishVoiceLanguage(language: SofiaVoiceLanguage | null | undefined): boolean {
  return language === 'es';
}
