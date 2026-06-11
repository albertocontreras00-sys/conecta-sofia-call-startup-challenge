import { allSofiaLiveVoiceTools } from '../../../services/voice/infobipMediaWebSocketGeminiTools.ts';
import type { GeminiFunctionDeclaration } from '../../../services/voice/infobipMediaWebSocketGeminiTypes.ts';

export function signaturesTools(): GeminiFunctionDeclaration[] {
  return allSofiaLiveVoiceTools();
}
