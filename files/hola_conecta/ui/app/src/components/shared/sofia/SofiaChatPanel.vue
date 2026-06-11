<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { SofiaMessage } from '@/types/sofia'

defineProps<{
  messages: SofiaMessage[]
  isBusy: boolean
  error: string
  lastRequestId: string
  feedbackSubmitting: boolean
  feedbackRating: 1 | -1 | null
  feedbackMessage: string
}>()

const textInput = defineModel<string>('textInput', { required: true })

defineEmits<{
  send: []
  back: []
  feedback: [rating: 1 | -1]
}>()

const messagesContainer = ref<HTMLDivElement | null>(null)
const textInputElement = ref<HTMLInputElement | null>(null)

function scrollMessagesToBottom(): void {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function focusInput(): void {
  nextTick(() => {
    textInputElement.value?.focus()
  })
}

defineExpose({
  focusInput,
  scrollMessagesToBottom
})
</script>

<template>
  <div class="text-mode">
    <div ref="messagesContainer" class="chat-messages">
      <div
        v-for="(msg, idx) in messages"
        :key="`${msg.role}-${idx}`"
        class="chat-message"
        :class="msg.role"
      >
        <p>{{ msg.content }}</p>
      </div>
      <div v-if="isBusy" class="chat-message assistant typing">
        <span class="typing-indicator">
          <span></span><span></span><span></span>
        </span>
      </div>
    </div>

    <div v-if="error" class="error-message">{{ error }}</div>

    <div v-if="lastRequestId && messages.length > 0" class="feedback-row">
      <span class="feedback-label">{{ $t('shared.sofia.wasHelpful') }}</span>
      <button
        class="feedback-btn"
        type="button"
        :disabled="feedbackSubmitting || feedbackRating === 1"
        @click="$emit('feedback', 1)"
      >
        <span>Yes</span>
      </button>
      <button
        class="feedback-btn"
        type="button"
        :disabled="feedbackSubmitting || feedbackRating === -1"
        @click="$emit('feedback', -1)"
      >
        <span>No</span>
      </button>
      <span v-if="feedbackMessage" class="feedback-msg">{{ feedbackMessage }}</span>
    </div>

    <form class="chat-form" @submit.prevent="$emit('send')">
      <input
        ref="textInputElement"
        v-model="textInput"
        type="text"
        :placeholder="$t('shared.sofia.typeYourQuestionEllipsis')"
        class="chat-input"
        :disabled="isBusy"
      />
      <button type="submit" class="send-btn" :disabled="isBusy || !textInput.trim()">
        {{ $t('actions.send') }}
      </button>
    </form>

    <button class="back-btn" type="button" :disabled="isBusy" @click="$emit('back')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
        <polyline points="15,18 9,12 15,6" />
      </svg>
      {{ $t('actions.back') }}
    </button>
  </div>
</template>

<style scoped>
.text-mode {
  flex: 1 1 auto;
  overflow: hidden;
  min-height: 0;
  padding: 24px 40px 40px;
  display: flex;
  flex-direction: column;
}

.chat-messages {
  flex: 1 1 auto;
  background: var(--page-bg, var(--surface-2));
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  max-height: 240px;
  min-height: 120px;
  overflow-y: auto;
}

.chat-message {
  margin-bottom: 12px;
}

.chat-message:last-child {
  margin-bottom: 0;
}

.chat-message.user p {
  background: var(--brand-color, #006847);
  color: white;
  padding: 10px 14px;
  border-radius: 12px 12px 4px 12px;
  margin: 0;
  font-size: 14px;
  display: inline-block;
  max-width: 85%;
  float: right;
  clear: both;
}

.chat-message.assistant p {
  background: #e5e7eb;
  color: #1f2937;
  padding: 10px 14px;
  border-radius: 12px 12px 12px 4px;
  margin: 0;
  font-size: 14px;
  display: inline-block;
  max-width: 85%;
  line-height: 1.5;
}

.chat-message.typing {
  clear: both;
}

.typing-indicator {
  display: inline-flex;
  gap: 4px;
  padding: 12px 16px;
  background: #e5e7eb;
  border-radius: 12px;
}

.typing-indicator span {
  width: 6px;
  height: 6px;
  background: #9ca3af;
  border-radius: 50%;
  animation: typing-bounce 1.4s ease-in-out infinite;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-6px);
  }
}

.error-message {
  background: #fef2f2;
  color: #b91c1c;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 16px;
}

.chat-form {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.chat-input {
  flex: 1;
  padding: 12px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.chat-input:focus {
  border-color: var(--brand-color, #006847);
}

.chat-input:disabled {
  background: #f9fafb;
}

.send-btn {
  padding: 10px 16px;
  border: none;
  border-radius: 10px;
  background: var(--brand-color, #006847);
  color: white;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.send-btn:hover:not(:disabled) {
  background: var(--brand-color-dark, #005a3a);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.feedback-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--page-bg, var(--surface-2));
  border-radius: 8px;
  margin-bottom: 16px;
}

.feedback-label {
  font-size: 13px;
  color: #64748b;
}

.feedback-btn {
  padding: 6px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: white;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.feedback-btn:hover:not(:disabled) {
  border-color: var(--brand-color, #006847);
  background: rgba(var(--brand-color-rgba, 0, 104, 71), 0.06);
}

.feedback-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.feedback-msg {
  font-size: 12px;
  color: var(--brand-color-dark, #005a3a);
  margin-left: auto;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: white;
  color: #64748b;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  align-self: flex-start;
}

.back-btn:hover:not(:disabled) {
  border-color: var(--brand-color, #006847);
  color: var(--brand-color, #006847);
}

.back-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .text-mode {
    padding: 20px 24px 32px;
  }
}
</style>
