<script setup lang="ts">
const lang = defineModel<string>('lang', { required: true })
</script>

<template>
  <div class="modal-footer">
    <div class="lang-selector">
      <label for="sofia-lang">{{ $t('shared.sofia.language') }}</label>
      <select id="sofia-lang" v-model="lang" class="lang-select">
        <option value="en-US">English</option>
        <option value="es-mx">Espanol</option>
      </select>
    </div>
    <div class="help-contact">
      {{ $t('shared.sofia.needMoreHelp') }}
      <a href="mailto:ayuda@holaconecta.com" class="help-email">ayuda@holaconecta.com</a>
    </div>
  </div>
</template>

<style scoped>
.modal-footer {
  flex: 0 0 auto;
  padding: 16px 24px;
  border-top: 1px solid #e5e7eb;
  background: var(--page-bg, var(--surface-2));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.lang-selector {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lang-selector label {
  font-size: 13px;
  color: #64748b;
}

.lang-select {
  padding: 6px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 13px;
  background: white;
  cursor: pointer;
}

.lang-select:focus {
  outline: none;
  border-color: var(--brand-color, #006847);
}

.help-contact {
  font-size: 13px;
  color: #64748b;
  display: flex;
  align-items: center;
  gap: 6px;
}

.help-email {
  color: var(--brand-color, #006847);
  text-decoration: none;
  font-weight: 600;
  transition: all 0.2s;
}

.help-email:hover {
  color: var(--brand-color-dark, #005a3a);
  text-decoration: underline;
}

@media (max-width: 480px) {
  .modal-footer {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .help-contact {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
}
</style>
