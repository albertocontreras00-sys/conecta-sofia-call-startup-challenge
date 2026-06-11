import { logInfo, logWarn } from '../../../utils/logger.js';
import { recordSofiaVoiceLiveDebugEvent } from '../sofiaVoiceLiveDebugStore.ts';
import { buildSofiaVoiceDebugJsonDump } from '../sofiaVoiceDeepDebugLog.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../sofiaVoiceJsonHandoffLogger.ts';
import { buildRealtimeAudioPayload } from '../infobipMediaWebSocketGemini.ts';
import type { GeminiDomain } from '../infobipMediaWebSocketGeminiTypes.ts';
import type { AudioLogCounters } from '../infobipMediaWebSocketObservability.ts';
import type { VoiceSession } from '../voiceSessionTypes.ts';
import { inferInfobipAudioEncoding } from '../voicePcmCodec.ts';
import { VOICE_WS_FRAME_DEBUG_ENABLED } from '../sofiaVoiceRuntimeConfig.ts';

type GeminiAudioBufferItem = {
  pcm16k: Buffer;
  receivedAt: number;
};

export type GeminiAudioBufferRuntime = {
  bufferGeminiAudio: (pcm16k: Buffer, infobipChunkBytes: number, reason: string) => void;
  flushBufferedGeminiAudio: (input: { domain: GeminiDomain; generation: number; initialCallStart: boolean }) => Promise<void>;
  sendGeminiAudio: (pcm16k: Buffer, infobipChunkBytes: number, source: 'live' | 'buffered') => void;
};

export function createGeminiAudioBufferRuntime(input: {
  audioLogCounters: AudioLogCounters;
  bufferMaxBytes: number;
  bufferWindowMs: number;
  getActiveGeminiDomain: () => GeminiDomain;
  getHandoffBufferBytes: () => number;
  getInfobipContentType: () => string | null;
  getSession: () => VoiceSession | null;
  handoffBuffer: GeminiAudioBufferItem[];
  isGeminiReadyForAudio: () => boolean;
  logContext: string;
  productionTraceMetadata: () => Record<string, unknown>;
  sendRealtimeAudioPayload: (payload: Record<string, unknown>) => void;
  setHandoffBufferBytes: (value: number) => void;
  shouldLogFrameDetail: (count: number) => boolean;
  startupFlushFrameIntervalMs: number;
}): GeminiAudioBufferRuntime {
  let lastRebindBufferReason: string | null = null;
  let rebindBufferNoticeLogged = false;

  function pruneHandoffBuffer(now = Date.now()): void {
    while (
      input.handoffBuffer.length
      && (
        now - (input.handoffBuffer[0]?.receivedAt ?? now) > input.bufferWindowMs
        || input.getHandoffBufferBytes() > input.bufferMaxBytes
      )
    ) {
      const dropped = input.handoffBuffer.shift();
      input.audioLogCounters.bufferedDuringRebindDroppedFrames += 1;
      input.audioLogCounters.bufferedDuringRebindDroppedBytes += dropped?.pcm16k.length || 0;
      input.setHandoffBufferBytes(Math.max(0, input.getHandoffBufferBytes() - (dropped?.pcm16k.length || 0)));
    }
  }

  function bufferGeminiAudio(pcm16k: Buffer, infobipChunkBytes: number, reason: string): void {
    const now = Date.now();
    input.handoffBuffer.push({ pcm16k, receivedAt: now });
    input.setHandoffBufferBytes(input.getHandoffBufferBytes() + pcm16k.length);
    pruneHandoffBuffer(now);
    input.audioLogCounters.bufferedDuringRebindFrames += 1;
    input.audioLogCounters.bufferedDuringRebindBytes += pcm16k.length;
    input.audioLogCounters.maxHandoffPendingFrames = Math.max(input.audioLogCounters.maxHandoffPendingFrames, input.handoffBuffer.length);
    input.audioLogCounters.maxHandoffPendingBytes = Math.max(input.audioLogCounters.maxHandoffPendingBytes, input.getHandoffBufferBytes());
    const shouldLogNotice = VOICE_WS_FRAME_DEBUG_ENABLED || !rebindBufferNoticeLogged || lastRebindBufferReason !== reason;
    lastRebindBufferReason = reason;
    rebindBufferNoticeLogged = true;
    if (!shouldLogNotice) return;
    const session = input.getSession();
    logWarn(input.logContext, 'voice.gemini.audio_buffering_started', {
      sessionId: session?.sessionId || null,
      callId: session?.callId || null,
      activeGeminiDomain: input.getActiveGeminiDomain(),
      reason,
      infobipChunkBytes,
      geminiPcmBytes: pcm16k.length,
      pendingFrames: input.handoffBuffer.length,
      pendingBytes: input.getHandoffBufferBytes(),
      bufferWindowMs: input.bufferWindowMs,
      maxBufferBytes: input.bufferMaxBytes,
      suppressedFrameLogs: Math.max(0, input.audioLogCounters.bufferedDuringRebindFrames - 1)
    });
  }

  function sendGeminiAudio(pcm16k: Buffer, infobipChunkBytes: number, source: 'live' | 'buffered'): void {
    const activeSession = input.getSession();
    if (!activeSession || !input.isGeminiReadyForAudio()) return;
    const activeGeminiDomain = input.getActiveGeminiDomain();
    activeSession.lastAudioInAt = Date.now();
    recordSofiaVoiceLiveDebugEvent({
      event: 'websocket_audio_last_received',
      callId: activeSession.callId,
      sessionId: activeSession.sessionId,
      orgId: activeSession.orgId,
      metadata: {
        activeGeminiDomain,
        source,
        infobipChunkBytes,
        geminiPcmBytes: pcm16k.length
      }
    });
    const realtimePayload = buildRealtimeAudioPayload(pcm16k);
    input.audioLogCounters.geminiRealtimePayloadsSent += 1;
    input.audioLogCounters.geminiRealtimePayloadBytes += pcm16k.length;
    const logGeminiFrameDetail = input.shouldLogFrameDetail(input.audioLogCounters.geminiRealtimePayloadsSent);
    if (logGeminiFrameDetail) logJsonHandoff({
      logContext: input.logContext,
      event: 'voice.json.gemini.realtime_audio_sender_to_receiver',
      sender: 'Sofia media WebSocket bridge',
      converter: 'buildRealtimeAudioPayload',
      receiver: 'Gemini Live',
      direction: 'sender_to_receiver',
      stage: 'realtime_audio_payload',
      status: 'sent',
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      orgId: activeSession.orgId,
      provider: 'gemini',
      payloadShape: buildJsonPayloadShape(realtimePayload),
      metadata: {
        activeGeminiDomain,
        source,
        infobipChunkBytes,
        geminiPcmBytes: pcm16k.length,
        frameType: 'audio',
        rawAudioLogged: false
      }
    });
    if (VOICE_WS_FRAME_DEBUG_ENABLED) logInfo(input.logContext, 'voice.gemini.realtime_audio_payload.shape_dump', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      activeGeminiDomain,
      source,
      realtimePayloadDump: buildSofiaVoiceDebugJsonDump({
        label: 'gemini_live_realtime_audio_payload',
        value: realtimePayload
      })
    });
    input.sendRealtimeAudioPayload(realtimePayload);
    if (logGeminiFrameDetail) logInfo(input.logContext, 'voice.ws.audio_frame.sent_to_gemini', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      activeGeminiDomain,
      source,
      infobipChunkBytes,
      geminiPcmBytes: pcm16k.length,
      mimeType: 'audio/pcm;rate=16000'
    });
    if (logGeminiFrameDetail) logInfo(input.logContext, 'voice.gemini.realtime_audio_sent', {
      ...input.productionTraceMetadata(),
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      activeGeminiDomain,
      source,
      infobipChunkBytes,
      geminiPcmBytes: pcm16k.length,
      sourceEncoding: inferInfobipAudioEncoding(input.getInfobipContentType()),
      sourceSampleRateHertz: activeSession.sampleRateHertz,
      targetSampleRateHertz: 16000
    });
  }

  async function flushBufferedGeminiAudio(flushInput: { domain: GeminiDomain; generation: number; initialCallStart: boolean }): Promise<void> {
    if (!input.isGeminiReadyForAudio()) return;
    const framesBeforePrune = input.handoffBuffer.length;
    const bytesBeforePrune = input.getHandoffBufferBytes();
    pruneHandoffBuffer();
    const droppedFrames = Math.max(0, framesBeforePrune - input.handoffBuffer.length);
    const droppedBytes = Math.max(0, bytesBeforePrune - input.getHandoffBufferBytes());
    const bufferedFramesBeforeFlush = input.handoffBuffer.length;
    const bufferedBytesBeforeFlush = input.getHandoffBufferBytes();
    const flushPaced = flushInput.initialCallStart === true;
    const pacingIntervalMs = flushPaced ? input.startupFlushFrameIntervalMs : 0;
    const drainStartedAt = Date.now();
    let flushedFrames = 0;
    let flushedBytes = 0;
    let skippedFrames = 0;
    const skippedBytes = 0;
    const session = input.getSession();
    const activeGeminiDomain = input.getActiveGeminiDomain();
    if (bufferedFramesBeforeFlush > 0) {
      logInfo(input.logContext, 'voice.gemini.audio_buffer_flush_started', {
        sessionId: session?.sessionId || null,
        callId: session?.callId || null,
        activeGeminiDomain,
        flushDomain: flushInput.domain,
        generation: flushInput.generation,
        startupHandoffFlush: flushInput.initialCallStart === true,
        flushPaced,
        pacingIntervalMs,
        bufferedFrames: bufferedFramesBeforeFlush,
        bufferedBytes: bufferedBytesBeforeFlush,
        handoffBufferFrames: bufferedFramesBeforeFlush,
        handoffBufferBytes: bufferedBytesBeforeFlush,
        droppedFrames,
        droppedBytes,
        skippedFrames,
        skippedBytes
      });
    }
    try {
      while (input.handoffBuffer.length && input.isGeminiReadyForAudio() && (!flushPaced || flushedFrames < bufferedFramesBeforeFlush)) {
        const item = input.handoffBuffer.shift();
        if (!item) {
          skippedFrames += 1;
          continue;
        }
        input.setHandoffBufferBytes(Math.max(0, input.getHandoffBufferBytes() - item.pcm16k.length));
        flushedFrames += 1;
        flushedBytes += item.pcm16k.length;
        sendGeminiAudio(item.pcm16k, 0, 'buffered');
        if (flushPaced && input.handoffBuffer.length && input.isGeminiReadyForAudio()) {
          await new Promise((resolve) => setTimeout(resolve, pacingIntervalMs));
        }
      }
    } finally {
      if (bufferedFramesBeforeFlush > 0) {
        const drainDurationMs = Date.now() - drainStartedAt;
        logInfo(input.logContext, 'voice.gemini.audio_buffer_flush_completed', {
          sessionId: session?.sessionId || null,
          callId: session?.callId || null,
          activeGeminiDomain,
          flushDomain: flushInput.domain,
          generation: flushInput.generation,
          startupHandoffFlush: flushInput.initialCallStart === true,
          flushPaced,
          pacingIntervalMs,
          drainDurationMs,
          bufferedFrames: bufferedFramesBeforeFlush,
          bufferedBytes: bufferedBytesBeforeFlush,
          handoffBufferFrames: bufferedFramesBeforeFlush,
          handoffBufferBytes: bufferedBytesBeforeFlush,
          flushedFrames,
          flushedBytes,
          droppedFrames,
          droppedBytes,
          skippedFrames,
          skippedBytes,
          remainingFrames: input.handoffBuffer.length,
          remainingBytes: input.getHandoffBufferBytes()
        });
      }
    }
  }

  return {
    bufferGeminiAudio,
    flushBufferedGeminiAudio,
    sendGeminiAudio
  };
}
