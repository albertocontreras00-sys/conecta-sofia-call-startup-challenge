<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { Delete, Mic, MicOff, Phone, PhoneForwarded, PhoneOff, X } from 'lucide-vue-next'
import { useOutboundPhoneDialerPresentation } from '@/composables/phone/usePhoneCallPresentation'
import {
  phoneLiveCallStatusLabel,
  safePhoneLiveCallDisplay,
  sofiaOperatorStatusLabel,
} from '@/composables/phone/phoneLiveCallPresentation'
import type {
  BrowserPhoneActiveCallPhase,
  BrowserPhoneCallState,
} from '@/composables/phone/useIncomingPhoneTransfers'
import type { PhoneLiveCallProjection } from '@/composables/phone/usePhoneLiveCallsFirestoreRealtime'

const props = defineProps<{
  modelValue: string
  normalizedNumber: string | null
  loading: boolean
  canCall: boolean
  callState: BrowserPhoneCallState
  activeCallPhase: BrowserPhoneActiveCallPhase
  activeCallLabel: string
  projectedActiveCall: PhoneLiveCallProjection | null
  activeCallStartedAt: string | null
  activeCallMuted: boolean
  activeCallControlError: string | null
  transferringActiveCall: boolean
  canMuteActiveCall: boolean
  canSendDtmf: boolean
  hasBrowserCall: boolean
  canAnswerIncomingCall: boolean
  canTransferActiveCall: boolean
  canDeclineToVoicemail: boolean
  incomingActionHandledExternally?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  digit: [value: string]
  backspace: []
  clear: []
  call: []
  mute: []
  dtmf: [value: string]
  acceptIncomingCall: []
  transfer: []
  end: []
  declineToVoicemail: []
}>()

const { handleInput, keys } = useOutboundPhoneDialerPresentation(emit)
const nowTick = shallowRef(Date.now())
let timerId: number | null = null

const hasProjectedLiveCall = computed(() => props.projectedActiveCall !== null)
const hasLiveCall = computed(() => props.hasBrowserCall || hasProjectedLiveCall.value)
const showBrowserCallControls = computed(() => props.hasBrowserCall && !props.incomingActionHandledExternally)
const showIncomingBrowserAnswer = computed(() => showBrowserCallControls.value && props.callState === 'incoming')
const sofiaOperatorLabel = computed(() => sofiaOperatorStatusLabel(props.projectedActiveCall))
const showSofiaOperatorStatus = computed(() => sofiaOperatorLabel.value !== null || props.projectedActiveCall?.source === 'sofia')

const callStateLabel = computed(() => {
  if (!props.hasBrowserCall && props.projectedActiveCall) return phoneLiveCallStatusLabel(props.projectedActiveCall)
  if (props.projectedActiveCall?.status === 'transferring') return 'Transferring'
  if (props.projectedActiveCall?.status === 'held') return 'On Hold'
  if (props.projectedActiveCall?.status === 'ending') return 'Ending'
  if (props.activeCallPhase === 'ringing') return 'Ringing'
  if (props.activeCallPhase === 'muted') return 'Muted'
  if (props.activeCallPhase === 'transferring') return 'Transferring'
  if (props.activeCallPhase === 'connected') return 'Connected'
  return 'Ended'
})

const displayActiveCallLabel = computed(() => {
  if (props.activeCallLabel !== 'Live call') return props.activeCallLabel
  return safePhoneLiveCallDisplay(props.projectedActiveCall, props.activeCallLabel)
})

const callTimer = computed(() => {
  const startedAt = props.activeCallStartedAt || props.projectedActiveCall?.startedAt
  if (!startedAt) return '00:00'
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return '00:00'
  const elapsedSeconds = Math.max(0, Math.floor((nowTick.value - started) / 1000))
  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0')
  const seconds = (elapsedSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
})

onMounted(() => {
  timerId = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timerId !== null) window.clearInterval(timerId)
})
</script>

<template>
  <section class="phone-live-panel">
    <template v-if="!hasLiveCall">
      <header class="phone-live-panel__header">
        <div>
          <h2>Make a call</h2>
          <p class="phone-helper">Dial a number or use the keypad to place an outbound call.</p>
        </div>
      </header>

      <div class="phone-live-panel__field">
        <label for="phone-page-number">Phone number</label>
        <input
          id="phone-page-number"
          type="tel"
          :value="modelValue"
          autocomplete="tel"
          inputmode="tel"
          placeholder="(555) 555-5555"
          @input="handleInput"
        >
        <p>{{ normalizedNumber ? `Ready to call ${normalizedNumber}` : 'Enter a US phone number' }}</p>
      </div>

      <div class="phone-live-panel__keypad" aria-label="Dial pad">
        <button
          v-for="key in keys"
          :key="key"
          type="button"
          class="phone-live-panel__key"
          @click="emit('digit', key)"
        >
          {{ key }}
        </button>
      </div>

      <div class="phone-live-panel__dial-actions">
        <button type="button" class="phone-live-panel__secondary" :disabled="loading || !modelValue" @click="emit('backspace')">
          <Delete class="phone-live-panel__icon" />
          Backspace
        </button>
        <button type="button" class="phone-live-panel__secondary" :disabled="loading || !modelValue" @click="emit('clear')">
          <X class="phone-live-panel__icon" />
          Clear
        </button>
        <button type="button" class="phone-live-panel__call" :disabled="!canCall" @click="emit('call')">
          <Phone class="phone-live-panel__icon" />
          {{ loading ? 'Calling...' : 'Call' }}
        </button>
      </div>
    </template>

    <template v-else>
      <header class="phone-live-panel__active-header">
        <div>
          <p class="phone-live-panel__eyebrow">{{ callStateLabel }}</p>
          <h2>{{ displayActiveCallLabel }}</h2>
          <p v-if="showSofiaOperatorStatus" class="phone-live-panel__operator-note phone-helper">
            {{ sofiaOperatorLabel || 'Sofia is handling this call' }}
            <template v-if="projectedActiveCall?.currentSafeAction && projectedActiveCall.currentSafeAction !== 'none'">
              · {{ projectedActiveCall.currentSafeAction }}
            </template>
          </p>
        </div>
        <div class="phone-live-panel__timer">{{ callTimer }}</div>
      </header>

      <div v-if="showBrowserCallControls" class="phone-live-panel__active-actions">
        <button
          v-if="showIncomingBrowserAnswer"
          type="button"
          class="phone-live-panel__answer"
          :disabled="!canAnswerIncomingCall"
          @click="emit('acceptIncomingCall')"
        >
          <Phone class="phone-live-panel__control-icon" />
          Answer
        </button>
        <button type="button" class="phone-live-panel__control" :disabled="!canMuteActiveCall" @click="emit('mute')">
          <MicOff v-if="!activeCallMuted" class="phone-live-panel__control-icon" />
          <Mic v-else class="phone-live-panel__control-icon" />
          {{ activeCallMuted ? 'Unmute' : 'Mute' }}
        </button>
        <button type="button" class="phone-live-panel__control" disabled title="Hold is not supported by the current WebRTC call path">
          Hold unavailable
        </button>
        <button type="button" class="phone-live-panel__control" :disabled="!canTransferActiveCall || transferringActiveCall" @click="emit('transfer')">
          <PhoneForwarded class="phone-live-panel__control-icon" />
          Transfer
        </button>
        <button type="button" class="phone-live-panel__end" @click="emit('end')">
          <PhoneOff class="phone-live-panel__control-icon" />
          End Call
        </button>
        <button
          v-if="canDeclineToVoicemail"
          type="button"
          class="phone-live-panel__voicemail"
          @click="emit('declineToVoicemail')"
        >
          <PhoneOff class="phone-live-panel__control-icon" />
          Decline to voicemail
        </button>
      </div>

      <p v-else-if="!incomingActionHandledExternally" class="phone-live-panel__readonly-note">This live call is read-only here until it is transferred to your browser phone.</p>

      <div v-if="showBrowserCallControls" class="phone-live-panel__keypad phone-live-panel__keypad--compact" aria-label="In-call keypad">
        <button
          v-for="key in keys"
          :key="key"
          type="button"
          class="phone-live-panel__key"
          :disabled="!canSendDtmf"
          @click="emit('dtmf', key)"
        >
          {{ key }}
        </button>
      </div>

      <p v-if="activeCallControlError" class="phone-live-panel__error">{{ activeCallControlError }}</p>
    </template>
  </section>
</template>

<style scoped>
@import './phone.tokens.css';
@import './phone.shared.css';

.phone-live-panel {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  border: 1px solid var(--phone-border);
  border-radius: 8px;
  background: #ffffff;
  padding: 16px;
  box-shadow: var(--phone-shadow-sm);
}

.phone-live-panel__header,
.phone-live-panel__active-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.phone-live-panel__eyebrow {
  margin: 0 0 4px;
  color: var(--phone-ink-soft);
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.phone-live-panel h2 {
  margin: 0;
  color: var(--phone-ink);
  font-size: 18px;
  line-height: 1.2;
}

.phone-live-panel__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.phone-live-panel__field label {
  color: var(--phone-ink-muted);
  font-size: 13px;
  font-weight: 800;
}

.phone-live-panel__field input {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--phone-border-strong);
  border-radius: 6px;
  color: var(--phone-ink);
  font-size: 18px;
  padding: 8px 10px;
}

.phone-live-panel__field input:focus {
  border-color: var(--phone-brand);
  box-shadow: var(--phone-focus-ring);
  outline: none;
}

.phone-live-panel__field p,
.phone-live-panel__error {
  min-height: 18px;
  margin: 0;
  color: var(--phone-ink-soft);
  font-size: 12px;
}

.phone-live-panel__error {
  color: #b91c1c;
  font-weight: 700;
}

.phone-live-panel__keypad {
  display: grid;
  width: min(100%, 252px);
  align-self: center;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}

.phone-live-panel__keypad--compact {
  width: min(100%, 260px);
  gap: 6px;
}

.phone-live-panel__key {
  aspect-ratio: 1.18;
  min-height: 42px;
  border: 1px solid var(--phone-border-strong);
  border-radius: 6px;
  background: var(--phone-surface-subtle);
  color: var(--phone-ink);
  font-size: 18px;
  font-weight: 800;
  cursor: pointer;
}

.phone-live-panel__key:hover:not(:disabled) {
  background: var(--phone-brand-soft);
}

.phone-live-panel__dial-actions,
.phone-live-panel__active-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.phone-live-panel__active-actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.phone-live-panel__secondary,
.phone-live-panel__call,
.phone-live-panel__answer,
.phone-live-panel__control,
.phone-live-panel__end,
.phone-live-panel__voicemail {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 6px;
  font-weight: 800;
  cursor: pointer;
}

.phone-live-panel__secondary,
.phone-live-panel__control {
  border: 1px solid var(--phone-border-strong);
  background: #ffffff;
  color: var(--phone-ink);
}

.phone-live-panel__call {
  border: 1px solid var(--phone-brand);
  background: var(--phone-brand);
  color: #ffffff;
}

.phone-live-panel__answer {
  border: 1px solid var(--phone-brand);
  background: var(--phone-brand);
  color: #ffffff;
}

.phone-live-panel__end {
  border: 1px solid #b91c1c;
  background: #b91c1c;
  color: #ffffff;
}

.phone-live-panel__voicemail {
  border: 1px solid #b91c1c;
  background: #ffffff;
  color: #b91c1c;
}

.phone-live-panel__secondary:disabled,
.phone-live-panel__call:disabled,
.phone-live-panel__answer:disabled,
.phone-live-panel__control:disabled,
.phone-live-panel__voicemail:disabled,
.phone-live-panel__key:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.phone-live-panel__icon,
.phone-live-panel__control-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

.phone-live-panel__timer {
  min-width: 72px;
  border: 1px solid var(--phone-border-strong);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--phone-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 16px;
  font-weight: 800;
  text-align: center;
}

.phone-live-panel__call-state {
  display: inline-flex;
  width: fit-content;
  min-height: 30px;
  align-items: center;
  border: 1px solid var(--phone-brand-border);
  border-radius: 999px;
  background: var(--phone-brand-soft);
  color: var(--phone-brand);
  font-size: 13px;
  font-weight: 800;
  padding: 0 12px;
}

.phone-live-panel__operator-note {
  margin: 6px 0 0;
}

.phone-live-panel__operator {
  display: grid;
  gap: 4px;
  border: 1px solid var(--phone-brand-border);
  border-radius: 8px;
  background: var(--phone-brand-soft);
  padding: 12px;
}

.phone-live-panel__operator-eyebrow {
  margin: 0;
  color: var(--phone-brand-dark);
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.phone-live-panel__operator strong {
  color: var(--phone-ink);
  font-size: 15px;
}

.phone-live-panel__operator span,
.phone-live-panel__readonly-note {
  margin: 0;
  color: var(--phone-ink-muted);
  font-size: 13px;
  line-height: 1.4;
}

@media (max-width: 560px) {
  .phone-live-panel {
    gap: 12px;
    padding: 14px;
  }

  .phone-live-panel h2 {
    font-size: 18px;
  }

  .phone-live-panel__field input {
    min-height: 46px;
    font-size: 20px;
  }

  .phone-live-panel__keypad {
    width: 100%;
    gap: 8px;
  }

  .phone-live-panel__key {
    aspect-ratio: auto;
    min-height: 56px;
    font-size: 20px;
  }

  .phone-live-panel__dial-actions,
  .phone-live-panel__active-actions {
    grid-template-columns: 1fr;
  }
}

@media (min-width: 561px) and (max-width: 820px) {
  .phone-live-panel__keypad {
    width: min(100%, 420px);
  }

  .phone-live-panel__key {
    aspect-ratio: auto;
    min-height: 64px;
    font-size: 22px;
  }
}
</style>
