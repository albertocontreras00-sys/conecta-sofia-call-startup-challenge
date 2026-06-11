import { computed, ref } from 'vue'
import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  type FirestoreValue,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js'
import { initializeFirebaseClient } from '@/stores/auth/firebaseAuthClient'
import { frontendLogger } from '@/utils/frontendLogger'

type RealtimeStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface PhoneLiveCallProjection {
  callId: string
  providerCallId: string | null
  sessionId: string | null
  direction: 'inbound' | 'outbound' | 'internal' | 'unknown'
  status: 'ringing' | 'active' | 'transferring' | 'held' | 'ending' | 'ended' | 'failed' | 'unknown'
  source: 'infobip' | 'sofia' | 'browser_webrtc' | 'internal_extension' | 'unknown'
  callerPhoneMasked: string | null
  callerDisplay: string | null
  calleePhoneMasked: string | null
  targetDisplay: string | null
  assignedUserId: string | null
  targetUserId: string | null
  callerExtension: string | null
  targetExtension: string | null
  transferIntentId: string | null
  transferStatus: string | null
  sofiaStatus: string | null
  currentSafeAction: string | null
  language: string | null
  startedAt: string | null
  updatedAt: string | null
  endedAt: string | null
}

interface SubscribePhoneLiveCallsArgs {
  orgId: string
  onCallChanged(call: PhoneLiveCallProjection): void
  onCallRemoved(callId: string): void
}

function asString(value: FirestoreValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function asDirection(value: FirestoreValue | undefined): PhoneLiveCallProjection['direction'] {
  if (value === 'inbound' || value === 'outbound' || value === 'internal') return value
  return 'unknown'
}

function asStatus(value: FirestoreValue | undefined): PhoneLiveCallProjection['status'] {
  if (
    value === 'ringing'
    || value === 'active'
    || value === 'transferring'
    || value === 'held'
    || value === 'ending'
    || value === 'ended'
    || value === 'failed'
  ) {
    return value
  }
  return 'unknown'
}

function asSource(value: FirestoreValue | undefined): PhoneLiveCallProjection['source'] {
  if (value === 'infobip' || value === 'sofia' || value === 'browser_webrtc' || value === 'internal_extension') return value
  return 'unknown'
}

function toLiveCall(docSnapshot: QueryDocumentSnapshot): PhoneLiveCallProjection | null {
  const data = docSnapshot.data()
  const callId = asString(data.callId) || docSnapshot.id
  if (!callId) return null
  return {
    callId,
    providerCallId: asString(data.providerCallId),
    sessionId: asString(data.sessionId),
    direction: asDirection(data.direction),
    status: asStatus(data.status),
    source: asSource(data.source),
    callerPhoneMasked: asString(data.callerPhoneMasked),
    callerDisplay: asString(data.callerDisplay),
    calleePhoneMasked: asString(data.calleePhoneMasked),
    targetDisplay: asString(data.targetDisplay),
    assignedUserId: asString(data.assignedUserId),
    targetUserId: asString(data.targetUserId),
    callerExtension: asString(data.callerExtension),
    targetExtension: asString(data.targetExtension),
    transferIntentId: asString(data.transferIntentId),
    transferStatus: asString(data.transferStatus),
    sofiaStatus: asString(data.sofiaStatus),
    currentSafeAction: asString(data.currentSafeAction),
    language: asString(data.language),
    startedAt: asString(data.startedAt),
    updatedAt: asString(data.updatedAt),
    endedAt: asString(data.endedAt),
  }
}

export function usePhoneLiveCallsFirestoreRealtime() {
  const connectionStatus = ref<RealtimeStatus>('disconnected')
  const lastConnectionDetail = ref('')
  let unsubscribeHandle: Unsubscribe | null = null

  function subscribe(args: SubscribePhoneLiveCallsArgs): void {
    unsubscribeHandle?.()
    connectionStatus.value = 'connecting'
    lastConnectionDetail.value = ''

    const { app } = initializeFirebaseClient('[PhoneLiveCallsFirestore]')
    const firestore = getFirestore(app)
    const liveCallsQuery = query(collection(firestore, 'accounts', args.orgId, 'phoneLiveCalls'))

    unsubscribeHandle = onSnapshot(
      liveCallsQuery,
      (snapshot) => {
        connectionStatus.value = 'connected'
        lastConnectionDetail.value = ''
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'removed') {
            args.onCallRemoved(change.doc.id)
            return
          }
          const liveCall = toLiveCall(change.doc)
          if (!liveCall) return
          if (liveCall.status === 'ending' || liveCall.status === 'ended' || liveCall.status === 'failed') {
            args.onCallRemoved(liveCall.callId)
            return
          }
          args.onCallChanged(liveCall)
        })
      },
      (error) => {
        connectionStatus.value = 'error'
        lastConnectionDetail.value = error.message
        frontendLogger.error('[PhoneLiveCallsFirestore] listener failed', {
          orgId: args.orgId,
          error: error.message,
        })
      }
    )
  }

  function disconnect(): void {
    unsubscribeHandle?.()
    unsubscribeHandle = null
    connectionStatus.value = 'disconnected'
    lastConnectionDetail.value = ''
  }

  return {
    connectionStatus: computed(() => connectionStatus.value),
    lastConnectionDetail: computed(() => lastConnectionDetail.value),
    subscribe,
    disconnect,
  }
}
