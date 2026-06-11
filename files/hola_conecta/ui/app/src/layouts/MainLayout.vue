<template>
  <div class="main-layout" :class="{ 'is-mobile': isMobile }">
    <VOnboardingWrapper
      ref="onboardingWrapper"
      :steps="onboardingSteps"
      :options="onboardingOptions"
      @finish="clearActiveOnboardingGuide"
      @exit="clearActiveOnboardingGuide"
    />

    <Sidebar
      :is-mobile="isMobile"
      :is-open="sidebarOpen"
      @close-mobile="closeSidebar"
    />

    <div class="content-area">
      <MobileAppHeader
        v-if="isMobile"
        :title="pageTitle"
        @toggle-menu="openSidebar"
      >
        <template #actions>
          <button
            v-if="!hideSupportButton"
            type="button"
            class="mobile-support-btn"
            @click="showSofiaModal = true"
            title="Help"
          >
            Help
          </button>
        </template>
      </MobileAppHeader>
      <AppTopBar
        v-if="!isMobile && shouldShowTopBar"
        :show-support-button="!hideSupportButton"
        @open-support="showSofiaModal = true"
      >
        <template v-if="topBarLeft" #left>
          <span class="top-bar-slot top-bar-slot--left">{{ topBarLeft }}</span>
        </template>
        <template v-if="topAnnouncement" #announcement>
          <div class="top-announcement" :class="`top-announcement--${topAnnouncement.tone}`">
            <span class="top-announcement__text">{{ topAnnouncement.text }}</span>
          </div>
        </template>
        <template v-else-if="showPartnerBanner" #announcement>
          <div class="top-partner-offer">
            <span class="top-partner-offer__text">New: Offer insurance to your clients without getting licensed.</span>
            <button type="button" class="top-partner-offer__cta" @click="openPartnerOffer">
              Learn More
            </button>
          </div>
        </template>
        <template v-if="topBarRight" #right>
          <span class="top-bar-slot top-bar-slot--right">{{ topBarRight }}</span>
        </template>
      </AppTopBar>
      <router-view v-slot="{ Component }">
        <component :is="Component" :key="$route.fullPath" />
      </router-view>
    </div>

    <div
      v-if="isMobile && sidebarOpen"
      class="sidebar-overlay"
      @click="closeSidebar"
    ></div>

    <!-- Sofia Support Modal -->
    <SofiaSupportModal v-model="showSofiaModal" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, defineAsyncComponent, nextTick, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useMediaQuery } from '@vueuse/core'
import { VOnboardingWrapper, type StepEntity, type VOnboardingWrapperOptions } from 'v-onboarding'
import 'v-onboarding/dist/style.css'
import Sidebar from '@/components/Sidebar.vue'
import MobileAppHeader from '@/components/shared/MobileAppHeader.vue'
import AppTopBar from '@/components/shared/AppTopBar.vue'
import { useBrandColor } from '@/composables/useBrandColor'
import { useOnboardingGuides } from '@/composables/useOnboardingGuides'
import { usePermissionsStore } from '@/stores/permissions'
import { useUserStore } from '@/stores/user'
import { frontendLogger } from '@/utils/frontendLogger'
const SofiaSupportModal = defineAsyncComponent(() => import('@/components/shared/SofiaSupportModal.vue'))

const MOBILE_BREAKPOINT = 1024

const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`)
const sidebarOpen = ref(true)
const showSofiaModal = ref(false)
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { brandColor, brandColorDark } = useBrandColor()
const { activeOnboardingGuide, clearActiveOnboardingGuide } = useOnboardingGuides()
const permissionsStore = usePermissionsStore()
const userStore = useUserStore()
const onboardingWrapper = ref<{ start: () => void; goToStep: (_step: number | ((_currentStep: number) => number)) => void } | null>(null)
const onboardingSteps = shallowRef<StepEntity[]>([])
const currentOnboardingTarget = shallowRef<string | null>(null)
let activeOnboardingTargetCleanup: (() => void) | null = null
const calendarEventsTargets = new Set([
  '[data-onboarding="calendar-events-tab"]',
  '[data-onboarding="calendar-events-add-button"]',
  '[data-onboarding="calendar-events-list"]'
])
const calendarAvailabilityTargets = new Set([
  '[data-onboarding="calendar-availability-tab"]',
  '[data-onboarding="calendar-availability-member-selector"]',
  '[data-onboarding="calendar-availability-schedule"]',
  '[data-onboarding="calendar-availability-save"]'
])
const calendarBookingLinksTargets = new Set([
  '[data-onboarding="calendar-booking-links-tab"]',
  '[data-onboarding="calendar-booking-link-card"]',
  '[data-onboarding="calendar-booking-links-checklist"]',
  '[data-onboarding="calendar-booking-links-embed"]'
])
const onboardingOptions = {
  hideNextStepDuringHook: true,
  overlay: {
    enabled: true,
    padding: 8,
    borderRadius: 8,
    preventOverlayInteraction: false
  },
  labels: {
    previousButton: 'Back',
    nextButton: 'Next',
    finishButton: 'Finish'
  }
}

const hideSupportButton = computed(() => !!route.meta?.hideSupportButton)
const topBarFromMeta = (value: string | { text: string } | undefined | null): string | null => {
  if (!value) {
    return null
  }

  if (typeof value === 'string') {
    return value
  }

  return value.text
}

const topAnnouncement = computed(() => {
  const announcement = route.meta?.topAnnouncement
  if (!announcement) return null
  if (typeof announcement === 'string') {
    return {
      text: announcement,
      tone: 'brand'
    }
  }
  return {
    text: announcement.text,
    tone: announcement.tone ?? 'brand'
  }
})
const topBarRight = computed(() => topBarFromMeta(route.meta?.topBarRight))
const showPartnerBanner = computed(() => route.name !== 'partner-offer-silverline-insurance')
const shouldShowTopBar = computed(() => !hideSupportButton.value || !!topAnnouncement.value || showPartnerBanner.value)
const partnerBannerAnalyticsProps = computed(() => ({
  org_id: permissionsStore.orgId,
  user_id: permissionsStore.userId,
  role: permissionsStore.userRole,
  plan: userStore.subscriptionPlan,
  partner_key: 'silverline',
  source: 'top_promo_bar',
  target_type: 'contact',
}))
let trackedPartnerBannerView = false

const translateOr = (key: string, fallback?: string) => {
  const value = t(key)
  if (value === key && fallback) {
    return fallback
  }
  return value
}

sidebarOpen.value = !isMobile.value

watch(isMobile, (current) => {
  sidebarOpen.value = !current
})

watch(
  () => route.fullPath,
  () => {
    if (isMobile.value) {
      sidebarOpen.value = false
    }
  }
)

const openSidebar = (): void => {
  sidebarOpen.value = true
}

const closeSidebar = (): void => {
  sidebarOpen.value = false
}

function trackPartnerBannerView(): void {
  if (trackedPartnerBannerView || !showPartnerBanner.value) return
  trackedPartnerBannerView = true
  frontendLogger.info('[PartnerReferrals] partner_banner_view', partnerBannerAnalyticsProps.value)
}

function openPartnerOffer(): void {
  frontendLogger.info('[PartnerReferrals] partner_banner_click', partnerBannerAnalyticsProps.value)
  void router.push({ name: 'partner-offer-silverline-insurance' })
}

watch(showPartnerBanner, () => {
  trackPartnerBannerView()
}, { immediate: true })

function getGuideRouteForTarget(target: string): { path: string; query?: Record<string, string | undefined> } | null {
  if (target === '[data-onboarding="settings-calendar-card"]') {
    return {
      path: '/settings',
      query: {
        category: 'home',
        domain: undefined,
        section: undefined,
        calendarTab: undefined
      }
    }
  }

  if (
    target === '[data-onboarding="settings-calendar-tabs"]' ||
    target === '[data-onboarding="settings-google-calendar-tab"]' ||
    target === '[data-onboarding="google-calendar-connect"]'
  ) {
    return {
      path: '/settings',
      query: {
        domain: 'scheduling',
        category: 'scheduling',
        section: 'google-calendar',
        calendarTab: 'google-calendar'
      }
    }
  }

  if (
    target === '[data-onboarding="settings-outlook-calendar-tab"]' ||
    target === '[data-onboarding="outlook-calendar-connect"]'
  ) {
    return {
      path: '/settings',
      query: {
        domain: 'scheduling',
        category: 'scheduling',
        section: 'microsoft-calendar',
        calendarTab: 'microsoft-calendar'
      }
    }
  }

  if (calendarEventsTargets.has(target)) {
    return {
      path: '/settings',
      query: {
        domain: 'scheduling',
        category: 'scheduling',
        section: 'events',
        calendarTab: 'events'
      }
    }
  }

  if (calendarAvailabilityTargets.has(target)) {
    return {
      path: '/settings',
      query: {
        domain: 'scheduling',
        category: 'scheduling',
        section: 'availability',
        calendarTab: 'availability'
      }
    }
  }

  if (calendarBookingLinksTargets.has(target)) {
    return {
      path: '/settings',
      query: {
        domain: 'scheduling',
        category: 'scheduling',
        section: 'booking-links',
        calendarTab: 'booking-links'
      }
    }
  }

  return null
}

function clearActiveOnboardingTargetListener(): void {
  activeOnboardingTargetCleanup?.()
  activeOnboardingTargetCleanup = null
}

function waitForOnboardingTarget(selector: string, timeoutMs = 3000): Promise<Element | null> {
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const check = () => {
      const element = resolveOnboardingTargetElement(selector)
      if (element) {
        resolve(element)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(null)
        return
      }

      window.setTimeout(check, 50)
    }

    check()
  })
}

function getOnboardingFallbackTarget(target: string): string {
  if (calendarEventsTargets.has(target)) {
    return '[data-onboarding="calendar-events-tab"]'
  }

  if (calendarAvailabilityTargets.has(target)) {
    return '[data-onboarding="calendar-availability-tab"]'
  }

  if (calendarBookingLinksTargets.has(target)) {
    return '[data-onboarding="calendar-booking-links-tab"]'
  }

  return target
}

function resolveOnboardingTargetElement(target: string): Element | null {
  return document.querySelector(target) ?? document.querySelector(getOnboardingFallbackTarget(target))
}

async function prepareOnboardingStepTarget(target: string, stepIndex: number): Promise<void> {
  clearActiveOnboardingTargetListener()
  currentOnboardingTarget.value = target

  const guideRoute = getGuideRouteForTarget(target)
  if (guideRoute) {
    await router.push({
      path: guideRoute.path,
      query: {
        ...route.query,
        ...guideRoute.query
      }
    }).catch(() => undefined)
  }

  await nextTick()
  await waitForOnboardingTarget(target)
  if (target === '[data-onboarding="settings-calendar-tabs"]') {
    setupProviderTabChoiceListeners(stepIndex)
  }
}

function buildOnboardingSteps(guide: { steps?: ReadonlyArray<{ target: string; content: string }> }): StepEntity[] {
  return (guide.steps || []).map((step, index) => ({
    attachTo: { element: () => resolveOnboardingTargetElement(step.target) },
    content: {
      title: 'Booking Links & Calendar Setup',
      description: step.content
    },
    options: getOnboardingStepOptions(),
    on: {
      beforeStep: () => prepareOnboardingStepTarget(step.target, index),
      afterStep: () => clearActiveOnboardingTargetListener()
    }
  }))
}

function getOnboardingStepOptions(): VOnboardingWrapperOptions {
  return {
    popper: {
      modifiers: [
        { name: 'offset', options: { offset: [0, 12] } },
        { name: 'preventOverflow', options: { padding: 16 } }
      ]
    }
  }
}

function setupProviderTabChoiceListeners(stepIndex: number): void {
  const googleTab = document.querySelector('[data-onboarding="settings-google-calendar-tab"]')
  const outlookTab = document.querySelector('[data-onboarding="settings-outlook-calendar-tab"]')
  const cleanupFns: Array<() => void> = []

  if (googleTab) {
    const chooseGoogle = () => {
      window.setTimeout(() => {
        onboardingWrapper.value?.goToStep(stepIndex + 2)
      }, 0)
    }
    googleTab.addEventListener('click', chooseGoogle, { once: true })
    cleanupFns.push(() => googleTab.removeEventListener('click', chooseGoogle))
  }

  if (outlookTab) {
    const chooseOutlook = () => {
      window.setTimeout(() => {
        onboardingWrapper.value?.goToStep(stepIndex + 4)
      }, 0)
    }
    outlookTab.addEventListener('click', chooseOutlook, { once: true })
    cleanupFns.push(() => outlookTab.removeEventListener('click', chooseOutlook))
  }

  if (cleanupFns.length) {
    activeOnboardingTargetCleanup = () => {
      cleanupFns.forEach((cleanup) => cleanup())
    }
  }
}

watch(
  activeOnboardingGuide,
  async (guide) => {
    if (!guide) {
      clearActiveOnboardingTargetListener()
      currentOnboardingTarget.value = null
      onboardingSteps.value = []
      return
    }

    if (!guide.steps?.length) {
      await router.push(guide.route).catch(() => undefined)
      clearActiveOnboardingGuide()
      return
    }

    const firstStep = guide.steps[0]
    if (!firstStep) {
      clearActiveOnboardingGuide()
      return
    }

    onboardingSteps.value = buildOnboardingSteps(guide)
    await prepareOnboardingStepTarget(firstStep.target, 0)
    await nextTick()
    onboardingWrapper.value?.start()
  },
  { immediate: true }
)

type TitleResolver = () => string

const titleMap: Record<string, TitleResolver> = {
  contacts: () => translateOr('nav.contacts'),
  inbox: () => translateOr('nav.inbox'),
  lobby: () => translateOr('nav.lobby', 'Lobby'),
  businesses: () => translateOr('nav.businesses'),
  'team-chat': () => translateOr('nav.teamChat'),
  blasts: () => translateOr('nav.emailTextBlast'),
  workflows: () => translateOr('nav.workflowBuilder'),
  forms: () => translateOr('nav.forms'),
  'forms-list': () => translateOr('nav.forms'),
  'form-template-picker': () => translateOr('nav.forms'),
  'form-editor-new': () => translateOr('nav.forms'),
  'form-editor': () => translateOr('nav.forms'),
  'form-preview': () => translateOr('nav.forms'),
  'form-builder': () => translateOr('nav.forms'),
  'form-responses': () => translateOr('nav.forms'),
  'form-analytics': () => translateOr('nav.forms'),
  tasks: () => translateOr('nav.tasks'),
  phone: () => 'Phone',
  'phone-calls': () => 'Phone Calls',
  'resolution-cases': () => 'Resolution Cases',
  calendars: () => translateOr('calendar.title'),
  'calendar-settings': () => translateOr('calendar.settingsTitle', 'Calendar Settings'),
  opportunities: () => translateOr('nav.opportunities'),
  partners: () => 'Partners',
  'partner-offer-silverline-insurance': () => 'Partners',
  'partner-portals': () => 'Partner Portals',
  'partner-portal-detail': () => 'Partner Portals',
  'partner-portal-conecta-returns': () => 'Partner Portals',
  'partner-portal-my-introductions': () => 'My Introductions',
  billing: () => 'Payments',
  settings: () => translateOr('nav.settings'),
  'admin-dashboard': () => translateOr('nav.adminDashboard', 'Admin Dashboard'),
  'blog-admin': () => 'Blog Admin',
  'excel-import': () => 'Excel Import',
  'blog-editor': () => 'Blog Editor',
  households: () => 'Households',
  Analytics: () => translateOr('nav.analytics')
}

const pageTitle = computed<string>(() => {
  if (route.meta?.title) {
    return String(route.meta.title)
  }

  const routeName = typeof route.name === 'string' ? route.name : null
  const resolver = routeName ? titleMap[routeName] : undefined
  if (resolver) {
    return resolver()
  }
  return typeof route.name === 'string'
    ? route.name.replace(/-/g, ' ')
    : String(t('auth.appTitle'))
})
const topBarLeft = computed(() => topBarFromMeta(route.meta?.topBarLeft) || pageTitle.value)
</script>

<style scoped>
.main-layout {
  display: flex;
  height: 100vh;
  position: relative;
  background: #f8fbfa;
}

.main-layout.is-mobile {
  flex-direction: column;
  height: 100dvh;
  min-height: 100dvh;
}

.content-area {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  position: relative;
}

.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  z-index: 800; /* keep overlay above page content but below the sidebar so links remain clickable */
}

.top-announcement {
  display: inline-flex;
  align-items: center;
  max-width: min(100%, 680px);
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #1f2933;
  box-shadow: none;
}

.top-bar-slot--left {
  display: inline-flex;
  font-family: "Epilogue", sans-serif;
  font-size: 1.8rem;
  font-weight: 800;
  color: var(--brand-color, #006847);
  letter-spacing: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity 0.2s ease;
  line-height: 1;
}

.top-announcement--warning {
  background: transparent;
}

.top-announcement--critical {
  background: transparent;
}

.top-announcement__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  font-weight: 650;
}

.top-partner-offer {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: min(100%, 720px);
  min-width: 0;
  gap: 12px;
  color: #172033;
}

.top-partner-offer__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  font-weight: 700;
}

.top-partner-offer__cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--brand-color, #006847);
  border-radius: 8px;
  background: var(--brand-color, #006847);
  color: #ffffff;
  font-size: 0.8rem;
  font-weight: 800;
  cursor: pointer;
}

.top-partner-offer__cta:hover {
  background: var(--brand-color-dark, #005a3a);
  border-color: var(--brand-color-dark, #005a3a);
}

@media (max-width: 1024px) {
  .content-area {
    height: 100dvh;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: #fbfdfc;
  }

  .sidebar-overlay {
    left: min(80vw, 320px);
  }
}

/* Mobile Support Button */
.mobile-support-btn {
  height: 36px;
  padding: 0 14px;
  margin: 10px 0;
  align-self: center;
  border-radius: 10px;
  border: 1.5px solid rgba(0, 0, 0, 0.24);
  background: white;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #000000;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.mobile-support-btn:active {
  background: rgba(0, 0, 0, 0.05);
  transform: scale(0.94);
}

:global(.v-onboarding-item) {
  z-index: 1600;
  max-width: min(20rem, calc(100vw - 32px));
  box-sizing: border-box;
}

:global(.v-onboarding-item__actions button.v-onboarding-btn-primary) {
  background-color: v-bind('brandColor') !important;
  border-color: v-bind('brandColor') !important;
  color: #ffffff !important;
}

:global(.v-onboarding-item__actions button.v-onboarding-btn-primary:hover) {
  background-color: v-bind('brandColorDark') !important;
  border-color: v-bind('brandColorDark') !important;
}

:global(.v-onboarding-item__actions button.v-onboarding-btn-primary:focus) {
  outline-color: v-bind('brandColor') !important;
}
</style>
