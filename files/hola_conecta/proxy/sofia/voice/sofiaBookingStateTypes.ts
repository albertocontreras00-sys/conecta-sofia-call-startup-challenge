import type {
  BookingIntentState,
  VoiceTurnOutput
} from '../../services/voice/voiceSessionTypes.ts';

export type SofiaBookingTurnResult = {
  handled: boolean;
  state: BookingIntentState;
  output: VoiceTurnOutput | null;
};

export type SofiaBookingAgentDecision = {
  toolName: string;
  reason?: string | null;
  confidence?: number | null;
};

export class SofiaBookingStateDecisionRequiredError extends Error {
  code = 'SOFIA_BOOKING_STATE_DECISION_REQUIRED';

  constructor() {
    super('Sofia booking state requires an explicit booking agent decision');
    this.name = 'SofiaBookingStateDecisionRequiredError';
  }
}
