import {
answerTransferIntent,
createInternalExtensionCall,
declineTransferIntentToVoicemail,
loadPhoneTransferUsers,
simulateSofiaBrowserTransfer,
startWebrtcTestRing,
transferActiveBrowserCall,
updateInternalExtensionCallEvent,
type AnsweredTransferIntent,
type PhoneTransferUser,
type PhoneWebrtcTestRingResult,
type SofiaPhoneHarnessResult,
} from '@/services/phoneWebrtc.service'
import { frontendLogger } from '@/utils/frontendLogger'
import {
CallsApiEvent,
WebrtcCallOptions,
} from 'infobip-rtc'
import { watch } from 'vue'
import {
browserPhoneDiagnosticContext,
phoneTransferLog,
readinessReasonLabel,
summarizeMediaStream,
} from './browserPhoneDiagnostics'
import {
markBrowserPhoneAvailable,
setReadinessState,
stopPresenceHeartbeat
} from './browserPhonePresence'
import { startRingingTone,stopRingingTone,syncTransferIntentRingAlert } from './browserPhoneRingAlert'
import { createIncomingPhoneTransferActiveCallControls } from './incomingPhoneTransferActiveCallControls'
import { createIncomingPhoneTransferBrowserLifecycle } from './incomingPhoneTransferBrowserLifecycle'
import {
activeCallLabel,
activeCallPhase,
canAnswerIncomingCall,
canAnswerTransfer,
canCallInternalExtension,
canEnablePhoneCalls,
canMuteActiveCall,
canSendActiveCallDtmf,
canStartTestRing,
canTransferActiveCall,
hasIncomingInternalExtensionCall,
incomingInternalExtensionCallLabel,
phoneWebrtcBetaEnabled,
readyForSofiaBrowserTransfers,
} from './incomingPhoneTransferComputed'
import { createIncomingPhoneTransferRealtimeActions } from './incomingPhoneTransferRealtime'
import {
attachRemoteStream,
setRemoteAudioElement,
} from './incomingPhoneTransferRemoteAudio'
import {
activeCallControlError,
activeCallMuted,
activeCallStartedAt,
activeInternalCallDirection,
activeInternalCallEstablished,
activeInternalCallId,
activeInternalCallLabel,
activeTransferError,
activeTransferStatus,
activeTransferTargetId,
answerErrorMessage,
answeringIntentId,
audioInputDeviceAvailable,
autoAcceptNextIncoming,
betaStatus,
betaStatusError,
betaStatusLoaded,
betaStatusLoading,
browserPhoneExplicitlyEnabled,
browserPhoneIdentity,
browserWebrtcSupported,
callingExtensionId,
callState,
connectedIntentId,
connectedOutboundCallLogId,
connectingIntentId,
connectionState,
decliningTransferIntentId,
enablePhoneLoading,
incomingCall,
INTERNAL_EXTENSION_CALL_TIMEOUT_MS,
internalExtensionCallError,
lastPresenceHeartbeatAt,
lastSofiaHarnessResult,
lastTestRing,
loadingPendingTransfers,
loadingTransferUsers,
microphonePermissionStatus,
pendingOutboundCallLogId,
pendingTransferIntents,
pendingTransfersError,
phonePresence,
phonePresenceSignalError,
phonePresenceSignalStatus,
phoneTransferRuntimeFlags,
presenceHeartbeatActive,
readinessState,
rtcClient,
savedAvailabilityPreference,
sofiaHarnessError,
sofiaHarnessLoading,
speakerTestStatus,
TEST_RING_DELIVERY_TIMEOUT_MS,
testRingError,
testRingLoading,
transferRealtimeConnectionStatus,
transferRealtimeLastConnectionDetail,
transferRealtimeLastListenerError,
transferRealtimeStatus,
transferringActiveCall,
transferUsers,
voicemailActionStatus,
type BrowserSdkCall
} from './incomingPhoneTransferState'
export type {
BrowserPhoneActiveCallPhase,BrowserPhoneCallState,BrowserPhoneConnectionState,PhoneReadinessState
} from './incomingPhoneTransferState'

function onBrowserPhoneAvailable(source: 'connected' | 'reconnected'): Promise<void> {
  return markBrowserPhoneAvailable(source, () => startPhoneTransferRealtime())
}

function resetCallState(): void {
  clearInternalExtensionCallTimeout()
  stopRingingTone()
  incomingCall.value = null
  autoAcceptNextIncoming.value = false
  answeringIntentId.value = null
  connectingIntentId.value = null
  connectedIntentId.value = null
  pendingOutboundCallLogId.value = null
  connectedOutboundCallLogId.value = null
  activeInternalCallId.value = null
  activeInternalCallLabel.value = null
  activeInternalCallDirection.value = null
  activeInternalCallEstablished.value = false
  callingExtensionId.value = null
  activeTransferStatus.value = null
  activeTransferError.value = null
  activeCallStartedAt.value = null
  activeCallMuted.value = false
  activeCallControlError.value = null
  attachRemoteStream(null)
  if (connectionState.value === 'ready') {
    callState.value = 'idle'
    setReadinessState('AVAILABLE_TO_RING')
    syncTransferIntentRingAlert()
  }
}

function clearInternalExtensionCallTimeout(): void {
  if (phoneTransferRuntimeFlags.internalExtensionCallTimeoutTimer === null) return
  window.clearTimeout(phoneTransferRuntimeFlags.internalExtensionCallTimeoutTimer)
  phoneTransferRuntimeFlags.internalExtensionCallTimeoutTimer = null
}

function scheduleInternalExtensionCallTimeout(): void {
  clearInternalExtensionCallTimeout()
  phoneTransferRuntimeFlags.internalExtensionCallTimeoutTimer = window.setTimeout(() => {
    phoneTransferRuntimeFlags.internalExtensionCallTimeoutTimer = null
    if (!activeInternalCallId.value || activeInternalCallEstablished.value || callState.value === 'connected') return
    const activeCall = incomingCall.value
    phoneTransferLog('[PhoneWebRTC] internal extension call timed out', browserPhoneDiagnosticContext({
      sender: 'browser_call_state',
      receiver: 'phone_internal_extension_call_api',
      internalCallId: activeInternalCallId.value,
      timeoutMs: INTERNAL_EXTENSION_CALL_TIMEOUT_MS,
    }))
    void reportInternalExtensionCallEvent('missed', 'internal_extension_call_timeout')
    try {
      activeCall?.hangup()
    } catch {
      // Backend lifecycle reporting has already happened; SDK hangup failures should not revive the call.
    }
    callState.value = 'ended'
    resetCallState()
  }, INTERNAL_EXTENSION_CALL_TIMEOUT_MS)
}

async function loadTransferUsers(): Promise<void> {
  loadingTransferUsers.value = true
  activeTransferError.value = null
  try {
    transferUsers.value = await loadPhoneTransferUsers()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load transfer targets'
    activeTransferError.value = message
    frontendLogger.warn('[PhoneWebRTC] transfer users load failed', {
      error: message,
      ...browserPhoneDiagnosticContext(),
    })
  } finally {
    loadingTransferUsers.value = false
  }
}

async function prepareOutboundBrowserCall(): Promise<void> {
  if (!phoneWebrtcBetaEnabled.value) {
    throw new Error('Browser phone is not enabled for outbound calling')
  }
  if (connectionState.value !== 'ready') {
    await connectBrowserPhone({ forceReconnect: false })
  }
  if (connectionState.value !== 'ready') {
    throw new Error('Browser phone is not connected')
  }
  pendingOutboundCallLogId.value = null
  connectedOutboundCallLogId.value = null
  answerErrorMessage.value = null
  autoAcceptNextIncoming.value = true
  callState.value = 'connecting'
  setReadinessState('IN_CALL')
  stopRingingTone()
  phoneTransferLog('[PhoneWebRTC] outbound browser call auto-answer armed', browserPhoneDiagnosticContext({
    sender: 'outbound_phone_dialer',
    receiver: 'infobip_webrtc_sdk',
    nextAction: 'auto_accept_next_outbound_browser_sdk_call',
  }))
}

function registerOutboundBrowserCall(callLogId: string): void {
  pendingOutboundCallLogId.value = callLogId
  if (callState.value === 'connected') {
    connectedOutboundCallLogId.value = callLogId
  }
  phoneTransferLog('[PhoneWebRTC] outbound browser call registered', browserPhoneDiagnosticContext({
    sender: 'phone_outbound_call_api',
    receiver: 'browser_call_state',
    outboundCallLogId: callLogId,
  }))
}

function cancelOutboundBrowserCallPreparation(): void {
  if (!autoAcceptNextIncoming.value && !pendingOutboundCallLogId.value && !connectedOutboundCallLogId.value) return
  pendingOutboundCallLogId.value = null
  connectedOutboundCallLogId.value = null
  autoAcceptNextIncoming.value = false
  if (callState.value === 'connecting' && !incomingCall.value) {
    callState.value = 'idle'
    setReadinessState('AVAILABLE_TO_RING')
  }
  phoneTransferLog('[PhoneWebRTC] outbound browser call auto-answer canceled', browserPhoneDiagnosticContext({
    sender: 'outbound_phone_dialer',
    receiver: 'browser_call_state',
  }))
}

function setActiveTransferTarget(extensionId: string): void {
  activeTransferTargetId.value = extensionId
  activeTransferError.value = null
}

async function transferConnectedCall(): Promise<AnsweredTransferIntent | null> {
  if (!canTransferActiveCall.value || !connectedIntentId.value) return null
  const target = transferUsers.value.find((user) => user.extension_id === activeTransferTargetId.value) || null
  if (!target) {
    activeTransferError.value = 'Choose a staff member to transfer to'
    return null
  }
  if (!target.ready) {
    activeTransferError.value = readinessReasonLabel(target.readiness_reason)
    return null
  }
  if (typeof window !== 'undefined' && !window.confirm(`Transfer this call to ${target.transfer_label}?`)) {
    activeTransferStatus.value = null
    return null
  }

  transferringActiveCall.value = true
  activeTransferError.value = null
  activeTransferStatus.value = 'requested'
  try {
    const result = await transferActiveBrowserCall({
      sourceTransferIntentId: connectedIntentId.value,
      targetUserId: target.user_id,
      targetExtension: target.extension,
      reason: 'Staff transfer',
    })
    activeTransferStatus.value = result.status
    phoneTransferLog('[PhoneWebRTC] active call transfer requested', {
      sender: 'browser_active_call_controls',
      receiver: 'phone_transfer_intents_api',
      sourceTransferIntentId: connectedIntentId.value,
      targetUserId: target.user_id,
      targetExtension: target.extension,
      resultStatus: result.status,
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to transfer call'
    activeTransferError.value = message
    activeTransferStatus.value = 'failed'
    frontendLogger.error('[PhoneWebRTC] active call transfer failed', {
      error: message,
      sourceTransferIntentId: connectedIntentId.value,
      targetUserId: target.user_id,
      targetExtension: target.extension,
    })
    return null
  } finally {
    transferringActiveCall.value = false
  }
}

async function reportInternalExtensionCallEvent(
  event: 'ringing' | 'accepted' | 'declined' | 'ended' | 'failed' | 'missed',
  reason: string | null = null
): Promise<void> {
  const internalCallId = activeInternalCallId.value
  if (!internalCallId) return
  try {
    await updateInternalExtensionCallEvent({
      internalCallId,
      event,
      reason,
    })
    phoneTransferLog('[PhoneWebRTC] internal extension call lifecycle reported', browserPhoneDiagnosticContext({
      sender: 'infobip_webrtc_sdk',
      receiver: 'phone_internal_extension_call_api',
      internalCallId,
      event,
      reason,
    }))
  } catch (error) {
    frontendLogger.warn('[PhoneWebRTC] internal extension call lifecycle report failed', {
      sender: 'infobip_webrtc_sdk',
      receiver: 'phone_internal_extension_call_api',
      internalCallId,
      event,
      reason,
      error: error instanceof Error ? error.message : String(error),
      ...browserPhoneDiagnosticContext(),
    })
  }
}

async function startInternalExtensionCallToUser(target: PhoneTransferUser): Promise<void> {
  if (!canCallInternalExtension.value) return
  internalExtensionCallError.value = null
  callingExtensionId.value = target.extension_id
  try {
    if (!target.ready) {
      throw new Error(readinessReasonLabel(target.readiness_reason))
    }
    if (connectionState.value !== 'ready') {
      await connectBrowserPhone({ forceReconnect: false })
    }
    const client = rtcClient.value
    if (!client || connectionState.value !== 'ready') {
      throw new Error('Browser phone is not connected')
    }

    phoneTransferLog('[PhoneWebRTC] internal extension call request started', browserPhoneDiagnosticContext({
      sender: 'browser_team_extensions_panel',
      receiver: 'phone_internal_extension_call_api',
      targetUserId: target.user_id,
      targetExtension: target.extension,
      extensionId: target.extension_id,
    }))
    const internalCall = await createInternalExtensionCall({
      targetUserId: target.user_id,
      targetExtension: target.extension,
    })
    activeInternalCallId.value = internalCall.internalCallId
    activeInternalCallLabel.value = internalCall.targetDisplayLabel || `Ext ${internalCall.targetExtension}`
    activeInternalCallDirection.value = 'outgoing'
    activeInternalCallEstablished.value = false
    callState.value = 'connecting'
    stopPresenceHeartbeat('internal_extension_call_started')
    setReadinessState('IN_CALL')
    stopRingingTone()

    const callOptions = WebrtcCallOptions.builder()
      .setAudio(true)
      .setVideo(false)
      .setCustomData({
        source: 'conecta_internal_extension_call',
        internalCallId: internalCall.internalCallId,
        callerExtension: internalCall.callerExtension,
        targetExtension: internalCall.targetExtension,
      })
      .build()
    const call = client.callWebrtc(internalCall.targetWebrtcIdentity, callOptions)
    bindIncomingCall(call, 'webrtc')
    scheduleInternalExtensionCallTimeout()
    void reportInternalExtensionCallEvent('ringing')
    phoneTransferLog('[PhoneWebRTC] internal extension WebRTC call started', browserPhoneDiagnosticContext({
      sender: 'phone_internal_extension_call_api',
      receiver: 'infobip_webrtc_sdk',
      internalCallId: internalCall.internalCallId,
      targetUserId: internalCall.targetUserId,
      targetExtension: internalCall.targetExtension,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to call extension'
    internalExtensionCallError.value = message
    activeInternalCallId.value = null
    activeInternalCallLabel.value = null
    activeInternalCallDirection.value = null
    activeInternalCallEstablished.value = false
    callingExtensionId.value = null
    if (callState.value === 'connecting' && !incomingCall.value) {
      callState.value = 'idle'
      setReadinessState('AVAILABLE_TO_RING')
    }
    frontendLogger.warn('[PhoneWebRTC] internal extension call failed', {
      sender: 'browser_team_extensions_panel',
      receiver: 'phone_internal_extension_call_api',
      targetUserId: target.user_id,
      targetExtension: target.extension,
      error: message,
      ...browserPhoneDiagnosticContext(),
    })
  }
}

function resetConnectedCallFromTransferRemoval(removedTransferIntentIds: string[]): void {
  const activeTransferIntentId = connectedIntentId.value
  if (!activeTransferIntentId || callState.value !== 'connected') return
  if (!removedTransferIntentIds.includes(activeTransferIntentId)) return

  phoneTransferLog('[PhoneWebRTC] connected call reset from transfer realtime removal', browserPhoneDiagnosticContext({
    sender: 'firestore_phone_transfer_docs',
    receiver: 'browser_call_state',
    transferIntentId: activeTransferIntentId,
    removedTransferIntentIds,
  }))
  callState.value = 'ended'
  resetCallState()
}

function acceptIncomingCall(): void {
  if (!incomingCall.value) return
  if (!('accept' in incomingCall.value) || typeof incomingCall.value.accept !== 'function') return
  stopPresenceHeartbeat('incoming_call_accept')
  stopRingingTone()
  callState.value = 'connecting'
  setReadinessState('IN_CALL')
  autoAcceptNextIncoming.value = false
  phoneTransferLog('[PhoneWebRTC] auto-accept started', {
    transferIntentId: connectingIntentId.value,
    autoAccept: true,
  })
  incomingCall.value.accept()
}

function extractInternalCallCustomData(customData: unknown): { internalCallId: string | null; callerExtension: string | null; targetExtension: string | null } {
  if (typeof customData !== 'object' || customData === null) {
    return { internalCallId: null, callerExtension: null, targetExtension: null }
  }
  const payload = customData as Record<string, unknown>
  if (payload.source !== 'conecta_internal_extension_call') {
    return { internalCallId: null, callerExtension: null, targetExtension: null }
  }
  return {
    internalCallId: typeof payload.internalCallId === 'string' ? payload.internalCallId : null,
    callerExtension: typeof payload.callerExtension === 'string' ? payload.callerExtension : null,
    targetExtension: typeof payload.targetExtension === 'string' ? payload.targetExtension : null,
  }
}

function extractSofiaTransferCustomData(customData: unknown): { transferIntentId: string | null } {
  if (typeof customData !== 'object' || customData === null) {
    return { transferIntentId: null }
  }
  const payload = customData as Record<string, unknown>
  if (payload.source !== 'conecta_sofia_live_transfer') {
    return { transferIntentId: null }
  }
  return {
    transferIntentId: typeof payload.transferIntentId === 'string' ? payload.transferIntentId : null,
  }
}

function bindIncomingCall(call: BrowserSdkCall, source: 'application' | 'webrtc', eventCustomData: unknown = null): void {
  incomingCall.value = call
  const callCustomData = typeof call.customData === 'function' ? call.customData() : null
  const rawCustomData = callCustomData || eventCustomData
  const sdkCustomData = extractInternalCallCustomData(rawCustomData)
  const sdkTransferData = extractSofiaTransferCustomData(rawCustomData)
  if (sdkTransferData.transferIntentId) {
    connectingIntentId.value = sdkTransferData.transferIntentId
  }
  if (sdkCustomData.internalCallId) {
    activeInternalCallId.value = sdkCustomData.internalCallId
    activeInternalCallLabel.value = sdkCustomData.callerExtension ? `Ext ${sdkCustomData.callerExtension}` : 'Internal extension call'
    activeInternalCallDirection.value = activeInternalCallDirection.value || 'incoming'
    activeInternalCallEstablished.value = false
    scheduleInternalExtensionCallTimeout()
  }
  stopPresenceHeartbeat('incoming_call_received')
  callState.value = autoAcceptNextIncoming.value ? 'connecting' : 'incoming'
  setReadinessState(autoAcceptNextIncoming.value ? 'IN_CALL' : 'BUSY')
  if (!autoAcceptNextIncoming.value) startRingingTone({ source: 'sdk_incoming_call' })
  phoneTransferLog('[PhoneWebRTC] incoming SDK call received', {
    sender: 'infobip_webrtc_sdk',
    converter: 'useIncomingPhoneTransfers.bindIncomingCall',
    receiver: 'browser_call_state',
    incomingCallSource: source,
    autoAccept: autoAcceptNextIncoming.value,
    transferIntentId: connectingIntentId.value,
    internalCallId: activeInternalCallId.value,
    customDataSource: callCustomData ? 'call' : eventCustomData ? 'event' : 'none',
  })

  call.on(CallsApiEvent.RINGING, () => {
    void reportInternalExtensionCallEvent('ringing')
  })

  call.on(CallsApiEvent.ESTABLISHED, (event) => {
    clearInternalExtensionCallTimeout()
    stopRingingTone()
    testRingError.value = null
    sofiaHarnessError.value = null
    callState.value = 'connected'
    const establishedTransferIntentId = connectingIntentId.value
    connectedIntentId.value = establishedTransferIntentId
    if (establishedTransferIntentId) {
      pendingTransferIntents.value = pendingTransferIntents.value.filter(
        (intent) => intent.transfer_intent_id !== establishedTransferIntentId
      )
    }
    activeInternalCallEstablished.value = true
    activeCallStartedAt.value = new Date().toISOString()
    activeCallMuted.value = typeof call.muted === 'function' ? call.muted() : false
    if (pendingOutboundCallLogId.value) {
      connectedOutboundCallLogId.value = pendingOutboundCallLogId.value
    }
    setReadinessState('IN_CALL')
    phoneTransferLog('[PhoneWebRTC] call established', {
      sender: 'infobip_webrtc_sdk',
      converter: 'useIncomingPhoneTransfers.bindIncomingCall',
      receiver: 'browser_audio_element',
      incomingCallSource: source,
      transferIntentId: connectedIntentId.value,
      internalCallId: activeInternalCallId.value,
      streamPresent: Boolean(event.stream),
      eventKeys: Object.keys(event).sort(),
      streamShape: summarizeMediaStream(event.stream),
    })
    attachRemoteStream(event.stream)
    void reportInternalExtensionCallEvent('accepted')
  })

  call.on(CallsApiEvent.HANGUP, () => {
    const internalEvent = activeInternalCallEstablished.value
      ? 'ended'
      : activeInternalCallDirection.value === 'incoming'
        ? 'declined'
        : 'missed'
    callState.value = 'ended'
    void hangupOutboundProviderCall('sdk_hangup')
    void reportInternalExtensionCallEvent(internalEvent)
    phoneTransferLog('[PhoneWebRTC] call ended', {
      sender: 'infobip_webrtc_sdk',
      converter: 'useIncomingPhoneTransfers.bindIncomingCall',
      receiver: 'browser_call_state',
      incomingCallSource: source,
      transferIntentId: connectedIntentId.value || connectingIntentId.value,
      internalCallId: activeInternalCallId.value,
      internalEvent,
    })
    resetCallState()
  })

  call.on(CallsApiEvent.ERROR, () => {
    callState.value = 'error'
    answerErrorMessage.value = 'Unable to connect call'
    setReadinessState('UNAVAILABLE', 'Incoming call SDK error')
    frontendLogger.error('[PhoneWebRTC] incoming call sdk error', {
      sender: 'infobip_webrtc_sdk',
      converter: 'useIncomingPhoneTransfers.bindIncomingCall',
      receiver: 'browser_call_state',
      incomingCallSource: source,
      transferIntentId: connectedIntentId.value || connectingIntentId.value,
      internalCallId: activeInternalCallId.value,
    })
    void reportInternalExtensionCallEvent('failed', 'sdk_error')
    resetCallState()
  })

  if (autoAcceptNextIncoming.value) {
    acceptIncomingCall()
  }
}

const {
  resyncPendingTransferState,
  startPhoneTransferRealtime,
  stopPhoneTransferRealtime,
  stopBrowserPhonePresenceHeartbeat,
  scheduleSofiaHarnessDeliveryCheck,
} = createIncomingPhoneTransferRealtimeActions({
  resetConnectedCallFromTransferRemoval,
})

const {
  toggleActiveCallMute,
  sendActiveCallDtmf,
  hangupOutboundProviderCall,
  endActiveCall,
  declineIncomingCall,
} = createIncomingPhoneTransferActiveCallControls({
  resetCallState,
  reportInternalExtensionCallEvent,
})

const {
  initializePhoneBetaStatus,
  testSpeakerPlayback,
  connectBrowserPhone,
  enablePhoneCalls,
  restoreEnabledPhoneCalls,
  disconnectBrowserPhone,
} = createIncomingPhoneTransferBrowserLifecycle({
  bindIncomingCall,
  extractInternalCallCustomData,
  hangupOutboundProviderCall,
  onBrowserPhoneAvailable,
  reportInternalExtensionCallEvent,
  startPhoneTransferRealtime,
})

async function refreshPendingTransferIntents(): Promise<void> {
  startPhoneTransferRealtime(true)
  await resyncPendingTransferState('manual_refresh', { force: true })
}

async function answerPendingTransfer(intentId: string): Promise<AnsweredTransferIntent | null> {
  if (!canAnswerTransfer.value) return null

  phoneTransferLog('[PhoneWebRTC] transfer answer click', {
    sender: 'browser_transfer_alert',
    receiver: 'phone_transfer_answer_api',
    transferIntentId: intentId,
    connectionState: connectionState.value,
    readinessState: readinessState.value,
  })
  answeringIntentId.value = intentId
  connectingIntentId.value = null
  connectedIntentId.value = null
  answerErrorMessage.value = null
  autoAcceptNextIncoming.value = true
  callState.value = 'connecting'
  stopRingingTone()
  setReadinessState('IN_CALL')

  try {
    phoneTransferLog('[PhoneWebRTC] transfer answer request started', {
      sender: 'browser_transfer_alert',
      receiver: 'phone_transfer_answer_api',
      transferIntentId: intentId,
    })
    const answeredIntent = await answerTransferIntent(intentId)
    connectingIntentId.value = answeredIntent.transfer_intent_id
    phoneTransferLog('[PhoneWebRTC] answer API success waiting for incoming WebRTC call', {
      sender: 'phone_transfer_answer_api',
      receiver: 'infobip_webrtc_sdk',
      transferIntentId: answeredIntent.transfer_intent_id,
      status: answeredIntent.status,
      providerCallIdPresent: Boolean(answeredIntent.providerCallId),
      identity: answeredIntent.identity,
      nextAction: 'waiting_for_infobip_incoming_webrtc_call',
    })
    return answeredIntent
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to connect call'
    answerErrorMessage.value = 'Unable to connect call'
    callState.value = 'error'
    autoAcceptNextIncoming.value = false
    connectingIntentId.value = null
    setReadinessState('AVAILABLE_TO_RING')
    frontendLogger.error('[PhoneWebRTC] transfer answer failed', {
      sender: 'phone_transfer_answer_api',
      converter: 'useIncomingPhoneTransfers.answerPendingTransfer',
      receiver: 'browser_transfer_alert',
      error: message,
      transferIntentId: intentId,
    })
    return null
  } finally {
    answeringIntentId.value = null
  }
}

async function declinePendingTransferToVoicemail(intentId: string): Promise<void> {
  if (decliningTransferIntentId.value !== null) return
  decliningTransferIntentId.value = intentId
  pendingTransfersError.value = null
  voicemailActionStatus.value = 'Voicemail recording starting.'
  try {
    const result = await declineTransferIntentToVoicemail(intentId)
    pendingTransferIntents.value = pendingTransferIntents.value.filter(
      (intent) => intent.transfer_intent_id !== intentId
    )
    stopRingingTone()
    phoneTransferLog('[PhoneWebRTC] transfer declined to voicemail', browserPhoneDiagnosticContext({
      sender: 'browser_transfer_alert',
      receiver: 'phone_transfer_decline_to_voicemail_api',
      transferIntentId: result.transferIntentId,
      status: result.status,
      voicemailStarted: result.voicemailStarted,
      voicemailUnavailableReason: result.voicemailUnavailableReason,
    }))
    if (!result.voicemailStarted && result.voicemailUnavailableReason) {
      pendingTransfersError.value = `Transfer declined. Voicemail recording was not started: ${result.voicemailUnavailableReason}`
      voicemailActionStatus.value = null
    } else {
      voicemailActionStatus.value = 'Sent to voicemail. Voicemail recording starting.'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to send transfer to voicemail'
    pendingTransfersError.value = message
    voicemailActionStatus.value = null
    frontendLogger.warn('[PhoneWebRTC] transfer decline to voicemail failed', {
      sender: 'browser_transfer_alert',
      receiver: 'phone_transfer_decline_to_voicemail_api',
      transferIntentId: intentId,
      error: message,
      ...browserPhoneDiagnosticContext(),
    })
  } finally {
    decliningTransferIntentId.value = null
  }
}

async function declineIncomingCallToVoicemail(): Promise<void> {
  const activeCall = incomingCall.value
  if (!activeCall || callState.value !== 'incoming') return
  activeCallControlError.value = null
  voicemailActionStatus.value = 'Voicemail recording starting.'
  const internalCallId = activeInternalCallId.value
  const transferIntentId = internalCallId ? null : connectingIntentId.value
  try {
    stopRingingTone()
    if (internalCallId) {
      await reportInternalExtensionCallEvent('missed', 'declined_to_voicemail')
      activeInternalCallId.value = null
      activeInternalCallLabel.value = null
      activeInternalCallDirection.value = null
      activeInternalCallEstablished.value = false
    } else if (transferIntentId) {
      const result = await declineTransferIntentToVoicemail(transferIntentId)
      pendingTransferIntents.value = pendingTransferIntents.value.filter(
        (intent) => intent.transfer_intent_id !== transferIntentId
      )
      if (!result.voicemailStarted && result.voicemailUnavailableReason) {
        voicemailActionStatus.value = null
        activeCallControlError.value = `Call declined. Voicemail recording was not started: ${result.voicemailUnavailableReason}`
      }
    } else {
      voicemailActionStatus.value = null
      activeCallControlError.value = 'Call declined. Voicemail recording was not started: missing transfer intent.'
    }
    activeCall.hangup()
    callState.value = 'ended'
    if (!activeCallControlError.value) {
      voicemailActionStatus.value = internalCallId
        ? 'Sent to voicemail follow-up.'
        : 'Sent to voicemail. Voicemail recording starting.'
    }
    phoneTransferLog('[PhoneWebRTC] incoming call declined to voicemail', browserPhoneDiagnosticContext({
      sender: 'browser_incoming_call_alert',
      receiver: internalCallId ? 'phone_internal_extension_call_api' : 'phone_transfer_decline_to_voicemail_api',
      internalCallId,
      transferIntentId,
      voicemailStarted: !activeCallControlError.value,
    }))
    resetCallState()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to decline call'
    activeCallControlError.value = message
    voicemailActionStatus.value = null
    frontendLogger.warn('[PhoneWebRTC] incoming call decline to voicemail failed', {
      sender: 'browser_incoming_call_alert',
      receiver: internalCallId ? 'phone_internal_extension_call_api' : 'infobip_webrtc_sdk',
      internalCallId,
      error: message,
      ...browserPhoneDiagnosticContext(),
    })
  }
}

async function ringThisBrowserForTest(): Promise<PhoneWebrtcTestRingResult | null> {
  if (!canStartTestRing.value) return null
  testRingLoading.value = true
  testRingError.value = null
  try {
    await connectBrowserPhone({ forceReconnect: true })
    if (connectionState.value !== 'ready') {
      throw new Error('Browser phone did not reconnect')
    }
    const result = await startWebrtcTestRing()
    lastTestRing.value = result
    frontendLogger.info('[PhoneWebRTC] test ring submitted', {
      providerCallId: result.providerCallId,
      identity: result.identity,
      providerCallState: result.providerCallState,
      responseJson: result,
      ...browserPhoneDiagnosticContext(),
    })
    window.setTimeout(() => {
      if (lastTestRing.value?.providerCallId !== result.providerCallId) return
      if (callState.value === 'incoming' || callState.value === 'connecting' || callState.value === 'connected') return
      testRingError.value = 'Test ring was submitted but did not reach this browser. Try Go available again.'
      frontendLogger.warn('[PhoneWebRTC] test ring delivery timeout', {
        sender: 'infobip_webrtc_calls_api',
        converter: 'useIncomingPhoneTransfers.ringThisBrowserForTest',
        receiver: 'infobip_webrtc_sdk',
        providerCallId: result.providerCallId,
        identity: result.identity,
        providerCallState: result.providerCallState,
        ...browserPhoneDiagnosticContext(),
      })
    }, TEST_RING_DELIVERY_TIMEOUT_MS)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start test ring'
    testRingError.value = message
    frontendLogger.error('[PhoneWebRTC] test ring failed', { error: message })
    return null
  } finally {
    testRingLoading.value = false
  }
}

async function simulateSofiaTransferForThisBrowser(): Promise<SofiaPhoneHarnessResult | null> {
  if (sofiaHarnessLoading.value) return null
  sofiaHarnessLoading.value = true
  sofiaHarnessError.value = null
  const traceId = `sofia-browser-harness-${Date.now()}`
  phoneTransferLog('[PhoneWebRTC] Sofia harness request started', browserPhoneDiagnosticContext({
    sender: 'conecta_browser',
    receiver: 'sofia_phone_test_harness',
    traceId,
  }))
  try {
    const result = await simulateSofiaBrowserTransfer(traceId)
    lastSofiaHarnessResult.value = result
    phoneTransferLog('[PhoneWebRTC] Sofia harness request accepted', browserPhoneDiagnosticContext({
      sender: 'sofia_phone_test_harness',
      receiver: 'firestore_phone_transfer_docs',
      traceId: result.traceId,
      transferIntentId: result.transferIntentId,
      providerCallId: result.providerCallId,
      targetUserId: result.targetUserId,
      firebaseUidPresent: result.firebaseUidPresent,
      expectedBrowserEvents: result.expectedBrowserEvents,
    }))
    scheduleSofiaHarnessDeliveryCheck(result)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to simulate Sofia transfer'
    sofiaHarnessError.value = message
    frontendLogger.error('[PhoneWebRTC] Sofia harness request failed', {
      error: message,
      traceId,
      ...browserPhoneDiagnosticContext(),
    })
    return null
  } finally {
    sofiaHarnessLoading.value = false
  }
}

watch(transferRealtimeConnectionStatus, (status, previousStatus) => {
  if (status !== 'connected' || previousStatus === 'connected') return
  if (previousStatus !== 'error' && previousStatus !== 'disconnected') return
  void resyncPendingTransferState('transfer_realtime_connection_status_connected')
})

export function useIncomingPhoneTransfers() {
  return {
    pendingTransferIntents,
    loadingPendingTransfers,
    pendingTransfersError,
    answeringIntentId,
    decliningTransferIntentId,
    connectingIntentId,
    connectedIntentId,
    answerErrorMessage,
    transferUsers,
    loadingTransferUsers,
    activeTransferTargetId,
    activeTransferStatus,
    activeTransferError,
    transferringActiveCall,
    activeCallStartedAt,
    activeCallMuted,
    activeCallControlError,
    voicemailActionStatus,
    callingExtensionId,
    hasIncomingInternalExtensionCall,
    incomingInternalExtensionCallLabel,
    internalExtensionCallError,
    betaStatus,
    betaStatusLoaded,
    betaStatusLoading,
    betaStatusError,
    phoneWebrtcBetaEnabled,
    readinessState,
    phonePresence,
    microphonePermissionStatus,
    speakerTestStatus,
    enablePhoneLoading,
    testRingLoading,
    testRingError,
    lastTestRing,
    sofiaHarnessLoading,
    sofiaHarnessError,
    lastSofiaHarnessResult,
    connectionState,
    callState,
    browserPhoneIdentity,
    browserPhoneExplicitlyEnabled,
    savedAvailabilityPreference,
    transferRealtimeStatus,
    transferRealtimeConnectionStatus,
    transferRealtimeLastConnectionDetail,
    transferRealtimeLastListenerError,
    phonePresenceSignalStatus,
    phonePresenceSignalError,
    browserWebrtcSupported,
    audioInputDeviceAvailable,
    presenceHeartbeatActive,
    lastPresenceHeartbeatAt,
    canEnablePhoneCalls,
    canStartTestRing,
    canAnswerIncomingCall,
    canCallInternalExtension,
    canAnswerTransfer,
    canTransferActiveCall,
    canMuteActiveCall,
    canSendActiveCallDtmf,
    activeCallPhase,
    activeCallLabel,
    readyForSofiaBrowserTransfers,
    setRemoteAudioElement,
    prepareOutboundBrowserCall,
    registerOutboundBrowserCall,
    cancelOutboundBrowserCallPreparation,
    initializePhoneBetaStatus,
    enablePhoneCalls,
    restoreEnabledPhoneCalls,
    connectBrowserPhone,
    disconnectBrowserPhone,
    acceptIncomingCall,
    declineIncomingCall,
    declineIncomingCallToVoicemail,
    testSpeakerPlayback,
    refreshPendingTransferIntents,
    startPhoneTransferRealtime,
    stopPhoneTransferRealtime,
    stopBrowserPhonePresenceHeartbeat,
    answerPendingTransfer,
    declinePendingTransferToVoicemail,
    loadTransferUsers,
    setActiveTransferTarget,
    transferConnectedCall,
    startInternalExtensionCallToUser,
    toggleActiveCallMute,
    sendActiveCallDtmf,
    endActiveCall,
    ringThisBrowserForTest,
    simulateSofiaTransferForThisBrowser,
  }
}
