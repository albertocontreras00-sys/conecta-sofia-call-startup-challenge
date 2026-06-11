<script setup lang="ts">
defineProps<{
  avatarSrc: string
  avatarAnimationClass: Record<string, boolean>
  statusBadgeClass: Record<string, boolean>
  statusText: string
}>()
</script>

<template>
  <div class="avatar-section">
    <div class="avatar-wrapper" :class="avatarAnimationClass">
      <img :src="avatarSrc" alt="Sofia" class="sofia-avatar" />
    </div>
    <div class="status-badge" :class="statusBadgeClass">
      {{ statusText }}
    </div>
  </div>
</template>

<style scoped>
.avatar-section {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 32px 32px;
  background: var(--page-bg, var(--surface-2));
}

.avatar-wrapper {
  width: 210px;
  height: 210px;
  border-radius: 50%;
  overflow: hidden;
  box-shadow: 0 8px 40px rgba(var(--brand-color-rgba, 0, 104, 71), 0.2);
  transition: all 0.3s ease;
}

.avatar-wrapper.is-thinking {
  animation: thinking-pulse 1s ease-in-out infinite;
}

@keyframes thinking-pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

.sofia-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.status-badge {
  margin-top: 20px;
  padding: 10px 20px;
  border-radius: 999px;
  background: rgba(var(--brand-color-rgba, 0, 104, 71), 0.08);
  color: var(--brand-color, #006847);
  font-size: 16px;
  font-weight: 600;
  transition: all 0.2s;
}

.status-badge.is-active {
  background: rgba(var(--brand-color-rgba, 0, 104, 71), 0.15);
  color: var(--brand-color-dark, #005a3a);
}

@media (max-width: 768px) {
  .avatar-wrapper {
    width: 180px;
    height: 180px;
  }
}

@media (max-width: 480px) {
  .avatar-wrapper {
    width: 160px;
    height: 160px;
  }
}
</style>
