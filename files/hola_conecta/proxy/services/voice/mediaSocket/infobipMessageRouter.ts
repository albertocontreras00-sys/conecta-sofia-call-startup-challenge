import { logError, logInfo, logWarn } from '../../../utils/logger.js';
import { WebSocket } from 'ws';
import { parseInfobipControlMessage } from '../voiceSchemas.ts';
import type { InfobipControlMessage } from '../voiceSessionTypes.ts';
import { controlMessageCallId } from '../infobipMediaWebSocketSession.ts';
import {
  isHandshakeMessage,
  traceBinaryFrame,
  traceTextFrame
} from '../sofiaVoiceInfobipFrameHelpers.ts';
import {
  VOICE_WS_RAW_TRACE_MAX_BINARY_FRAMES,
  VOICE_WS_RAW_TRACE_MAX_TEXT_FRAMES
} from '../sofiaVoiceRuntimeConfig.ts';
import { buildSofiaVoiceDebugJsonDump } from '../sofiaVoiceDeepDebugLog.ts';
import { buildJsonPayloadShape, logJsonHandoff } from '../sofiaVoiceJsonHandoffLogger.ts';
import type { MediaSocketMessageRouterOptions } from './runtimeTypes.ts';

export function bindInfobipMessageRouter(options: MediaSocketMessageRouterOptions): void {
  const {
    correlationId,
    handleBinaryAudio,
    logContext,
    productionTraceMetadata,
    startRealtimeLoop,
    ws
  } = options;
  let rawTextFramesLogged = 0;
  let rawBinaryFramesLogged = 0;

  function session() {
    return options.getSession();
  }

  function handleControlMessage(message: InfobipControlMessage, payloadBytes: number): void {
    const activeSession = session();
    logJsonHandoff({
      logContext,
      event: 'voice.json.infobip_ws.control_frame_received',
      sender: 'Infobip media WebSocket',
      converter: 'voiceSchemas.parseInfobipControlMessage',
      receiver: 'Sofia media WebSocket service',
      direction: 'sender_to_converter',
      stage: 'control_frame_received',
      status: 'received',
      sessionId: activeSession?.sessionId || null,
      callId: activeSession?.callId || null,
      orgId: activeSession?.orgId || null,
      provider: 'infobip',
      payloadBytes,
      metadata: {
        correlationId,
        controlMessageType: message.type,
        frameType: 'text'
      }
    });
    logJsonHandoff({
      logContext,
      event: 'voice.json.infobip_ws.control_frame_converted',
      sender: 'voiceSchemas.parseInfobipControlMessage',
      converter: 'Infobip control frame normalizer',
      receiver: 'Sofia media WebSocket service',
      direction: 'converter_to_receiver',
      stage: 'control_frame_converted',
      status: 'converted',
      sessionId: activeSession?.sessionId || null,
      callId: activeSession?.callId || controlMessageCallId(message),
      orgId: activeSession?.orgId || null,
      provider: 'infobip',
      payloadShape: buildJsonPayloadShape(message),
      metadata: {
        correlationId,
        controlMessageType: message.type,
        frameType: message.type === 'media' ? 'media_json' : 'control_json',
        audioPayloadLogged: false,
        mediaBytes: message.type === 'media' ? message.payload.length : null
      }
    });
  }

  ws.on('message', (data, isBinary) => {
    try {
      const activeSession = session();
      if (isBinary) {
        if (rawBinaryFramesLogged < VOICE_WS_RAW_TRACE_MAX_BINARY_FRAMES) {
          rawBinaryFramesLogged += 1;
          traceBinaryFrame(data, {
            correlationId,
            sessionId: activeSession?.sessionId || null,
            callId: activeSession?.callId || null,
            rawFrameNumber: rawBinaryFramesLogged
          }, logContext);
        }
        handleBinaryAudio(data);
        return;
      }

      if (rawTextFramesLogged < VOICE_WS_RAW_TRACE_MAX_TEXT_FRAMES) {
        rawTextFramesLogged += 1;
        traceTextFrame(data, {
          correlationId,
          sessionId: activeSession?.sessionId || null,
          callId: activeSession?.callId || null,
          rawFrameNumber: rawTextFramesLogged
        }, logContext);
      }

      let message: InfobipControlMessage;
      try {
        message = parseInfobipControlMessage(data);
      } catch (parseError) {
        const currentSession = session();
        logWarn(logContext, 'voice.schema.infobip_control_parse.failed', {
          correlationId,
          sessionId: currentSession?.sessionId || null,
          callId: currentSession?.callId || null,
          eventType: 'invalid_text_frame',
          reason: parseError instanceof Error ? parseError.message : String(parseError),
          frameDump: buildSofiaVoiceDebugJsonDump({
            label: 'invalid_infobip_text_frame',
            value: Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
          })
        });
        if (!currentSession) throw parseError;
        return;
      }

      const currentSession = session();
      logInfo(logContext, 'voice.schema.infobip_control_parse.ok', {
        correlationId,
        sessionId: currentSession?.sessionId || null,
        callId: currentSession?.callId || null,
        controlMessageType: message.type,
        controlMessageDump: buildSofiaVoiceDebugJsonDump({
          label: 'infobip_control_message_parsed',
          value: message
        })
      });
      handleControlMessage(message, Buffer.isBuffer(data) ? data.length : Buffer.from(data as ArrayBuffer).length);

      if (!currentSession && isHandshakeMessage(message)) {
        logJsonHandoff({
          logContext,
          event: 'voice.json.infobip_ws.control_frame_forwarded',
          sender: 'Sofia media WebSocket service',
          converter: 'handshake message router',
          receiver: 'VoiceSession / Sofia live session',
          direction: 'converter_to_receiver',
          stage: 'handshake_forwarded_to_realtime_loop',
          status: 'forwarded',
          callId: message.type === 'connected' ? message.parentCallId || message.callId : message.callId,
          dialogId: message.dialogId,
          orgId: message.orgId,
          provider: 'infobip',
          payloadShape: buildJsonPayloadShape(message),
          metadata: {
            correlationId,
            controlMessageType: message.type
          }
        });
        void startRealtimeLoop(message).catch((error) => {
          const failedSession = session();
          logError(logContext, 'voice.ws.start_realtime_failed', error, {
            sessionId: failedSession?.sessionId || null,
            callId: failedSession?.callId || null,
            correlationId
          });
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Voice startup failed');
        });
        return;
      }

      if (!currentSession && message.type === 'unknown') return;
      if (message.type === 'media') {
        const mediaSession = session();
        logJsonHandoff({
          logContext,
          event: 'voice.json.infobip_ws.control_frame_forwarded',
          sender: 'Sofia media WebSocket service',
          converter: 'media JSON audio payload decoder',
          receiver: 'Infobip audio frame handler',
          direction: 'converter_to_receiver',
          stage: 'media_json_forwarded_to_audio_handler',
          status: 'forwarded',
          sessionId: mediaSession?.sessionId || null,
          callId: mediaSession?.callId || message.callId || null,
          orgId: mediaSession?.orgId || null,
          provider: 'infobip',
          metadata: {
            correlationId,
            controlMessageType: message.type,
            frameType: 'media_json',
            byteCount: message.payload.length,
            audioPayloadLogged: false
          }
        });
        handleBinaryAudio(message.payload);
        return;
      }

      if (message.type === 'stop') {
        const stopSession = session();
        logInfo(logContext, 'voice.ws.closed', {
          ...productionTraceMetadata(),
          sessionId: stopSession?.sessionId || null,
          callId: stopSession?.callId || message.callId,
          reason: message.reason || 'infobip_stop_message'
        });
        logJsonHandoff({
          logContext,
          event: 'voice.json.infobip_ws.control_frame_forwarded',
          sender: 'Sofia media WebSocket service',
          converter: 'stop control frame router',
          receiver: 'VoiceSession / Sofia live session',
          direction: 'converter_to_receiver',
          stage: 'stop_forwarded_to_session_close',
          status: 'forwarded',
          sessionId: stopSession?.sessionId || null,
          callId: stopSession?.callId || message.callId || null,
          orgId: stopSession?.orgId || null,
          provider: 'infobip',
          payloadShape: buildJsonPayloadShape(message),
          metadata: {
            correlationId,
            controlMessageType: message.type,
            reason: message.reason || 'infobip_stop_message'
          }
        });
        ws.close(1000, message.reason || 'Call stopped');
      }
    } catch (error) {
      const activeSession = session();
      logError(logContext, 'voice.ws.error', error, {
        sessionId: activeSession?.sessionId || null,
        callId: activeSession?.callId || null,
        correlationId
      });
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Voice WebSocket error');
    }
  });
}
