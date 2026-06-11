<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import BaseModal from '@/components/shared/BaseModal.vue'
import SofiaAvatarPanel from '@/components/shared/sofia/SofiaAvatarPanel.vue'
import SofiaChatPanel from '@/components/shared/sofia/SofiaChatPanel.vue'
import SofiaModalFooter from '@/components/shared/sofia/SofiaModalFooter.vue'
import SofiaModalHeader from '@/components/shared/sofia/SofiaModalHeader.vue'
import SofiaModeSelection from '@/components/shared/sofia/SofiaModeSelection.vue'
import { useSofiaSupportChat } from '@/composables/sofia/useSofiaSupportChat'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const chatPanel = ref<InstanceType<typeof SofiaChatPanel> | null>(null)

const isOpen = computed({
  get: () => props.modelValue,
  set: (val: boolean) => emit('update:modelValue', val)
})

const chat = useSofiaSupportChat({
  scrollMessagesToBottom: () => chatPanel.value?.scrollMessagesToBottom()
})

function handleSelectText(): void {
  chat.selectTextMode()
  nextTick(() => {
    chatPanel.value?.focusInput()
  })
}

function handleClose(): void {
  chat.resetToSelection()
  isOpen.value = false
}

watch(isOpen, (open: boolean) => {
  if (open) {
    chat.resetToSelection()
  }
})
</script>

<template>
  <BaseModal
    v-model="isOpen"
    title=""
    :show-header="false"
    content-class="sofia-modal-content"
    body-class="sofia-modal-body"
    @close="handleClose"
  >
    <SofiaModalHeader @close="handleClose" />
    <SofiaAvatarPanel
      :avatar-src="chat.avatarSrc.value"
      :avatar-animation-class="chat.avatarAnimationClass.value"
      :status-badge-class="chat.statusBadgeClass.value"
      :status-text="chat.statusText.value"
    />
    <SofiaModeSelection
      v-if="chat.mode.value === 'select'"
      @select-text="handleSelectText"
    />
    <SofiaChatPanel
      v-else-if="chat.mode.value === 'text'"
      ref="chatPanel"
      v-model:text-input="chat.textInput.value"
      :messages="chat.messages.value"
      :is-busy="chat.isBusy.value"
      :error="chat.error.value"
      :last-request-id="chat.lastRequestId.value"
      :feedback-submitting="chat.feedbackSubmitting.value"
      :feedback-rating="chat.feedbackRating.value"
      :feedback-message="chat.feedbackMessage.value"
      @send="chat.sendTextMessage"
      @back="chat.goBack"
      @feedback="chat.sendFeedback"
    />
    <SofiaModalFooter v-model:lang="chat.lang.value" />
  </BaseModal>
</template>

<style scoped>
:global(.sofia-modal-content) {
  max-width: 1040px;
  width: 90vw;
  max-height: 90vh;
  border-radius: 20px;
  overflow: hidden;
}

:global(.sofia-modal-body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 90vh;
  overflow: hidden;
}

@media (max-width: 768px) {
  :global(.sofia-modal-content) {
    max-width: 95vw;
    width: 95vw;
  }
}

@media (max-width: 480px) {
  :global(.sofia-modal-content) {
    max-width: 100%;
    margin: 0 8px;
  }
}
</style>
