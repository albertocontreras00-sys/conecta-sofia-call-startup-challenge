<script setup lang="ts">
defineEmits<{
  selectText: []
}>()
</script>

<template>
  <div class="mode-selection">
    <p class="mode-prompt">{{ $t('shared.sofia.chatWithSofia') }}</p>
    <div class="mode-buttons">
      <button class="mode-btn text-btn" type="button" @click="$emit('selectText')">
        <span class="mode-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <span class="mode-label">{{ $t('shared.sofia.chatWithSofia') }}</span>
        <span class="mode-desc">{{ $t('shared.sofia.typeYourQuestion') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mode-selection {
  flex: 1 1 auto;
  overflow: hidden;
  padding: 24px 40px 40px;
}

.mode-prompt {
  text-align: center;
  color: #64748b;
  font-size: 18px;
  margin: 0 0 24px;
  font-weight: 500;
}

.mode-buttons {
  display: flex;
  gap: 20px;
  justify-content: center;
  max-width: 600px;
  margin: 0 auto;
}

.mode-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 22px 17px;
  border: 2px solid #e5e7eb;
  border-radius: 16px;
  background: #ffffff;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-btn:hover {
  border-color: var(--brand-color, #006847);
  background: rgba(var(--brand-color-rgba, 0, 104, 71), 0.06);
}

.mode-icon {
  width: 58px;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: #f1f5f9;
  color: var(--brand-color, #006847);
}

.mode-icon svg {
  width: 32px;
  height: 32px;
}

.mode-btn:hover .mode-icon {
  background: rgba(var(--brand-color-rgba, 0, 104, 71), 0.1);
}

.mode-label {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}

.mode-desc {
  font-size: 12px;
  color: #64748b;
}

@media (max-width: 768px) {
  .mode-selection {
    padding: 20px 24px 32px;
  }
}

@media (max-width: 480px) {
  .mode-buttons {
    flex-direction: column;
    gap: 16px;
  }

  .mode-btn {
    padding: 17px 14px;
  }

  .mode-icon {
    width: 50px;
    height: 50px;
  }
}
</style>
