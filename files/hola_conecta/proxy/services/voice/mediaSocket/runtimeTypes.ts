import type { RawData, WebSocket } from 'ws';
import type { InfobipControlMessage, VoiceSession } from '../voiceSessionTypes.ts';

export type MediaSocketProductionTraceMetadata = () => Record<string, unknown>;

export type MediaSocketSessionAccess = {
  getSession: () => VoiceSession | null;
};

export type MediaSocketMessageRouterOptions = MediaSocketSessionAccess & {
  correlationId: string;
  handleBinaryAudio: (data: RawData) => void;
  logContext: string;
  productionTraceMetadata: MediaSocketProductionTraceMetadata;
  startRealtimeLoop: (handshake: Extract<InfobipControlMessage, { type: 'connected' | 'start' }>) => Promise<void>;
  ws: WebSocket;
};

export type MediaSocketFrameCounters = {
  inboundBytesReceived: number;
  inboundBytesSentToGemini: number;
  inboundFramesConvertedToGemini: number;
  inboundFramesReceived: number;
};

export type MediaSocketMediaFrameHandlerOptions = MediaSocketSessionAccess & {
  audioLogCounters: MediaSocketFrameCounters;
  bufferGeminiAudio: (pcm16k: Buffer, infobipChunkBytes: number, reason: string) => void;
  correlationId: string;
  getInfobipContentType: () => string | null;
  isGeminiReadyForAudio: () => boolean;
  isGeminiRebindInProgress: () => boolean;
  logContext: string;
  productionTraceMetadata: MediaSocketProductionTraceMetadata;
  sendGeminiAudio: (pcm16k: Buffer, infobipChunkBytes: number, source: 'live' | 'buffered') => void;
  shouldLogFrameDetail: (frameNumber: number) => boolean;
  ws: WebSocket;
};

export type MediaSocketConnectionLifecycleOptions = MediaSocketSessionAccess & {
  cleanup: (reason: string) => void;
  correlationId: string;
  currentTurnId: () => string | null;
  emitFinalSummary: (input: { timestamp: string; turnId: string | null }) => void;
  finalizeReceptionistCall: (closeReason: string) => Promise<void>;
  logAudioSummary: (event: string, code: number | null, reason: string) => void;
  logContext: string;
  productionTraceMetadata: MediaSocketProductionTraceMetadata;
  publishClosedLiveState: (input: { code: number }) => void;
  publishFailedLiveState: () => void;
  ws: WebSocket;
};
