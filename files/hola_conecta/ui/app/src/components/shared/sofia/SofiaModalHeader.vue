<script setup lang="ts">
defineEmits<{
  close: []
}>()
</script>

<template>
  <div class="sofia-modal-header">
    <div class="header-title">
      <img class="header-logo" src="/assets/conecta-avocado.svg" alt="Conecta Logo" />
      <h3>{{ $t('shared.sofia.conectaSupport') }}</h3>
    </div>
    <button class="close-btn" type="button" aria-label="Close" @click="$emit('close')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.sofia-modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 20px 24px 12px;
  background: color-mix(in srgb, var(--brand-color, #006847) 8%, var(--surface));
  border-bottom: 1px solid #e5e7eb;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-logo {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.header-title h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--brand-color, #006847);
}

.close-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #f3f4f6;
  color: #374151;
}

.close-btn svg {
  width: 20px;
  height: 20px;
}
</style>
