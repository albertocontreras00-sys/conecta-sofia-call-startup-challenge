import type { RawData } from 'ws';
import { logInfo, logWarn } from '../../../utils/logger.js';
import { voiceSessionManager } from '../voiceSessionManager.ts';
import {
  getInfobipLinear16Endianness,
  inferInfobipAudioEncoding,
  infobipAudioToGemini16kPcm
} from '../voicePcmCodec.ts';
import { outputFrameBytes } from '../sofiaVoiceInfobipFrameHelpers.ts';
import type { MediaSocketMediaFrameHandlerOptions } from './runtimeTypes.ts';

export function createInfobipMediaFrameHandler(options: MediaSocketMediaFrameHandlerOptions): (data: RawData) => void {
  return (data) => {
    const session = options.getSession();
    if (!session) {
      logWarn(options.logContext, 'voice.ws.error', {
        correlationId: options.correlationId,
        reason: 'binary_before_handshake'
      });
      options.ws.close(1008, 'Handshake required before audio');
      return;
    }

    const infobipContentType = options.getInfobipContentType();
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    voiceSessionManager.markAudioIn(session, chunk.length, options.ws.readyState);
    options.audioLogCounters.inboundFramesReceived += 1;
    options.audioLogCounters.inboundBytesReceived += chunk.length;
    const logInboundFrameDetail = options.shouldLogFrameDetail(options.audioLogCounters.inboundFramesReceived);
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.ws.audio_frame.received', {
      ...options.productionTraceMetadata(),
      sessionId: session.sessionId,
      callId: session.callId,
      byteLength: chunk.length,
      contentType: infobipContentType,
      sampleRateHertz: session.sampleRateHertz,
      encoding: inferInfobipAudioEncoding(infobipContentType)
    });
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.audio.infobip_input.detected', {
      sessionId: session.sessionId,
      callId: session.callId,
      contentType: infobipContentType,
      encoding: inferInfobipAudioEncoding(infobipContentType),
      sampleRateHertz: session.sampleRateHertz,
      infobipLinear16Endianness: getInfobipLinear16Endianness()
    });
    const pcm16k = infobipAudioToGemini16kPcm(chunk, infobipContentType);
    options.audioLogCounters.inboundFramesConvertedToGemini += 1;
    options.audioLogCounters.inboundBytesSentToGemini += pcm16k.length;
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.ws.audio_frame.converted_to_gemini', {
      ...options.productionTraceMetadata(),
      sessionId: session.sessionId,
      callId: session.callId,
      inputBytes: chunk.length,
      outputBytes: pcm16k.length,
      sourceEncoding: inferInfobipAudioEncoding(infobipContentType),
      sourceSampleRateHertz: session.sampleRateHertz,
      targetEncoding: 'pcm_s16le',
      targetSampleRateHertz: 16000,
      mimeType: 'audio/pcm;rate=16000'
    });
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.audio.infobip_to_gemini.converted', {
      sessionId: session.sessionId,
      callId: session.callId,
      inputBytes: chunk.length,
      outputBytes: pcm16k.length,
      sourceSampleRateHertz: session.sampleRateHertz,
      targetSampleRateHertz: 16000,
      sourceEncoding: inferInfobipAudioEncoding(infobipContentType),
      targetEncoding: 'pcm_s16le'
    });
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.audio.sample_rate.detected', {
      sessionId: session.sessionId,
      callId: session.callId,
      sampleRateHertz: session.sampleRateHertz,
      contentType: infobipContentType
    });
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.audio.sample_rate.converted', {
      sessionId: session.sessionId,
      callId: session.callId,
      fromHertz: session.sampleRateHertz,
      toHertz: 16000
    });
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.audio.encoding.detected', {
      sessionId: session.sessionId,
      callId: session.callId,
      encoding: inferInfobipAudioEncoding(infobipContentType),
      contentType: infobipContentType
    });
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.audio.encoding.converted', {
      sessionId: session.sessionId,
      callId: session.callId,
      fromEncoding: inferInfobipAudioEncoding(infobipContentType),
      toEncoding: 'pcm_s16le'
    });
    if (logInboundFrameDetail) logInfo(options.logContext, 'voice.audio.frame_size.selected', {
      sessionId: session.sessionId,
      callId: session.callId,
      inputFrameBytes: chunk.length,
      outputFrameBytes: outputFrameBytes(session, infobipContentType)
    });

    if (!options.isGeminiReadyForAudio()) {
      options.bufferGeminiAudio(
        pcm16k,
        chunk.length,
        options.isGeminiRebindInProgress() ? 'gemini_rebinding' : 'gemini_not_ready'
      );
      return;
    }

    options.sendGeminiAudio(pcm16k, chunk.length, 'live');
  };
}

