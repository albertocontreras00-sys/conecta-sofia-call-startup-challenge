<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from 'vue'
import {
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-vue-next'
import PhoneVoicemailGreetingPanel from '@/components/phone/PhoneVoicemailGreetingPanel.vue'
import {
  cloneAddress,
  cloneBusinessLocations,
  createHoursShape,
  useClientPortalSettingsSection,
  type ClientPortalSettingsData,
  type DayKey,
  type PortalAddress,
  type PortalBusinessLocation,
  type PortalHours,
  type PortalHoursDay,
} from '@/composables/settings/useClientPortalSettingsSection'
import { useCommunicationSettingsSection } from '@/composables/settings/useCommunicationSettingsSection'
import { useOrgSettings } from '@/composables/shared/useOrgSettings'
import { useBookings } from '@/composables/useBookings'
import {
  listPhoneRoutes,
  updatePhoneRouteRouting,
  type PhoneRouteSettings,
} from '@/services/phoneCalls.service'
import {
  createUserExtension,
  loadStaffPhoneReadiness,
  loadWebrtcStatus,
  updateUserExtension,
  type PhoneWebrtcStatus,
  type StaffPhoneReadiness,
} from '@/services/phoneWebrtc.service'
import {
  createSofiaKnowledgeItem,
  deleteSofiaKnowledgeItem,
  loadSofiaKnowledgeItems,
  updateSofiaKnowledgeItem,
  type SofiaKnowledgeItem,
} from '@/services/sofiaSettings.service'
import apiService from '@/services/api'

type SofiaSection =
  | 'overview'
  | 'business-info'
  | 'hours-language'
  | 'appointments'
  | 'things-sofia-should-know'
  | 'extensions'
  | 'voicemail'

type KnowledgeDraft = {
  title: string
  instructions: string
  enabled: boolean
}

type BusinessDraft = {
  businessName: string
  description: string
  officePhone: string
  businessEmail: string
  website: string
  address: PortalAddress
  walkInsPolicy: string
  parkingNotes: string
  directionsNotes: string
  documentsNeededPolicy: string
  paymentMethodsPolicy: string
  pricingPolicy: string
  refundPolicy: string
  balancePaymentPolicy: string
  showInsurance: boolean
  showRealEstate: boolean
  showTaxResolution: boolean
  showPersonalTaxPrepBrochure: boolean
  showIncorporatingBrochure: boolean
  showBookkeepingBrochure: boolean
  showTaxResolutionBrochure: boolean
}

type ExtensionDraft = {
  extension: string
  displayName: string
  isActive: boolean
  externalForwardingEnabled: boolean
  externalForwardingPhoneNumber: string
}

type BookingEventOption = {
  id: string
  name?: string | null
  name_en?: string | null
  name_es?: string | null
  duration_minutes?: number | null
  is_active?: boolean | null
}

type BookingTeamMemberOption = {
  id: string
  displayName?: string | null
  email?: string | null
  booking_event_ids?: string[] | null
  is_bookable?: boolean | null
}

const props = defineProps<{
  activeTab: string
}>()

const dayKeys: DayKey[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const dayLabels: Record<DayKey, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

const { loadClientPortalSettings } = useClientPortalSettingsSection()
const { loadCommunicationSettings } = useCommunicationSettingsSection()
const { resetOrgSettingsCache } = useOrgSettings()
const {
  events: bookingEvents,
  teamMembers: bookingTeamMembers,
  loadEvents,
  loadTeamMembers,
  setEventTeamMembers,
} = useBookings()

const routes = shallowRef<PhoneRouteSettings[]>([])
const webrtcStatus = shallowRef<PhoneWebrtcStatus | null>(null)
const orgTimezone = shallowRef('')
const sofiaDefaultLanguage = shallowRef<'en' | 'es'>('en')
const knowledgeItems = shallowRef<SofiaKnowledgeItem[]>([])
const extensions = shallowRef<StaffPhoneReadiness[]>([])
const businessLocations = shallowRef<PortalBusinessLocation[]>([])

const loadingOverview = shallowRef(false)
const loadingBusiness = shallowRef(false)
const loadingAppointments = shallowRef(false)
const loadingKnowledge = shallowRef(false)
const loadingExtensions = shallowRef(false)
const savingBusiness = shallowRef(false)
const savingHours = shallowRef(false)
const savingAppointments = shallowRef(false)
const savingKnowledgeId = shallowRef<string | null>(null)
const savingExtensionId = shallowRef<string | null>(null)
const deletingKnowledgeId = shallowRef<string | null>(null)
const editingKnowledgeId = shallowRef<string | null>(null)
const addingKnowledge = shallowRef(false)
const errorMessage = shallowRef<string | null>(null)
const successMessage = shallowRef<string | null>(null)

const businessDraft = reactive<BusinessDraft>({
  businessName: '',
  description: '',
  officePhone: '',
  businessEmail: '',
  website: '',
  address: cloneAddress(),
  walkInsPolicy: '',
  parkingNotes: '',
  directionsNotes: '',
  documentsNeededPolicy: '',
  paymentMethodsPolicy: '',
  pricingPolicy: '',
  refundPolicy: '',
  balancePaymentPolicy: '',
  showInsurance: true,
  showRealEstate: true,
  showTaxResolution: true,
  showPersonalTaxPrepBrochure: true,
  showIncorporatingBrochure: true,
  showBookkeepingBrochure: true,
  showTaxResolutionBrochure: true,
})

const publicHoursDraft = reactive<PortalHours>(createHoursShape(dayKeys))
const newKnowledge = reactive<KnowledgeDraft>({
  title: '',
  instructions: '',
  enabled: true,
})
const knowledgeDrafts = reactive<Record<string, KnowledgeDraft>>({})
const extensionDrafts = reactive<Record<string, ExtensionDraft>>({})
const appointmentStaffDrafts = reactive<Record<string, string[]>>({})
const appointmentLocationDrafts = reactive<Record<string, string[]>>({})

const primaryRoute = computed(() => routes.value[0] || null)
const enabledKnowledgeCount = computed(() => knowledgeItems.value.filter((item) => item.enabled).length)
const activeExtensionCount = computed(() => extensions.value.filter((row) => row.extension_id && row.is_active !== false).length)
const readyBrowserExtensionCount = computed(() => extensions.value.filter((row) => row.ready_for_sofia_browser_transfer).length)
const forwardingEnabledCount = computed(() => extensions.value.filter((row) => row.external_forwarding_enabled === true).length)
const activeBookingEvents = computed(() => (
  (bookingEvents.value as BookingEventOption[])
    .filter((event) => event.is_active !== false)
))
const bookableTeamMembers = computed(() => (
  (bookingTeamMembers.value as BookingTeamMemberOption[])
    .filter((member) => member.is_bookable === true)
))
const activeBusinessLocations = computed(() => businessLocations.value.filter((location) => location.isActive !== false))
const appointmentTypeCount = computed(() => activeBookingEvents.value.length)
const enabledServiceLabels = computed(() => {
  const labels: string[] = []
  if (businessDraft.showInsurance) labels.push('Insurance')
  if (businessDraft.showRealEstate) labels.push('Real estate')
  if (businessDraft.showTaxResolution) labels.push('Tax resolution')
  if (businessDraft.showPersonalTaxPrepBrochure) labels.push('Personal tax prep')
  if (businessDraft.showIncorporatingBrochure) labels.push('Incorporating')
  if (businessDraft.showBookkeepingBrochure) labels.push('Bookkeeping')
  if (businessDraft.showTaxResolutionBrochure) labels.push('Tax resolution brochure')
  return labels
})

function activeSection(): SofiaSection {
  if (props.activeTab === 'business-info') return 'business-info'
  if (props.activeTab === 'hours-language') return 'hours-language'
  if (props.activeTab === 'appointments') return 'appointments'
  if (props.activeTab === 'things-sofia-should-know') return 'things-sofia-should-know'
  if (props.activeTab === 'extensions') return 'extensions'
  if (props.activeTab === 'voicemail') return 'voicemail'
  return 'overview'
}

function showMessage(message: string): void {
  successMessage.value = message
  window.setTimeout(() => {
    if (successMessage.value === message) successMessage.value = null
  }, 2400)
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function cleanText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function languageLabel(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'Not configured'
  if (normalized === 'en' || normalized === 'en-us') return 'English'
  if (normalized === 'es' || normalized === 'es-us' || normalized === 'es-mx') return 'Spanish'
  return normalized
}

function bookingEventLabel(event: BookingEventOption): string {
  return event.name || event.name_en || event.name_es || 'Untitled appointment type'
}

function bookingTeamMemberLabel(member: BookingTeamMemberOption): string {
  return member.displayName || member.email || member.id
}

function normalizeEditableSofiaLanguage(value: string | null | undefined): 'en' | 'es' {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'es' || normalized === 'es-us' || normalized === 'es-mx' ? 'es' : 'en'
}

function setArrayValue(record: Record<string, string[]>, key: string, values: string[]): void {
  record[key] = [...values]
}

function toggleDraftValue(record: Record<string, string[]>, key: string, value: string, checked: boolean): void {
  const current = record[key] || []
  if (checked) {
    if (!current.includes(value)) record[key] = [...current, value]
    return
  }
  record[key] = current.filter((item) => item !== value)
}

function hydrateAppointmentDrafts(): void {
  for (const key of Object.keys(appointmentStaffDrafts)) delete appointmentStaffDrafts[key]
  for (const key of Object.keys(appointmentLocationDrafts)) delete appointmentLocationDrafts[key]

  for (const event of activeBookingEvents.value) {
    setArrayValue(
      appointmentStaffDrafts,
      event.id,
      bookableTeamMembers.value
        .filter((member) => Array.isArray(member.booking_event_ids) && member.booking_event_ids.includes(event.id))
        .map((member) => member.id),
    )
    setArrayValue(
      appointmentLocationDrafts,
      event.id,
      activeBusinessLocations.value
        .filter((location) => location.bookingEventIds.includes(event.id))
        .map((location) => locationDraftKey(location)),
    )
  }
}

function locationDraftKey(location: PortalBusinessLocation): string {
  return location.id || `${location.name}:${location.sortOrder}`
}

function locationLabel(location: PortalBusinessLocation): string {
  return location.name || (location.locationType === 'virtual' ? 'Virtual location' : 'Unnamed location')
}

function appointmentStaffCount(eventId: string): number {
  return appointmentStaffDrafts[eventId]?.length || 0
}

function appointmentLocationCount(eventId: string): number {
  return appointmentLocationDrafts[eventId]?.length || 0
}

function addressLine(address: PortalAddress): string {
  return [address.street, address.city, address.state, address.zip, address.country]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ') || 'Not configured'
}

function publicHoursSummary(hours: PortalHours): string {
  const openDays = dayKeys.filter((dayKey) => !hours[dayKey]?.closed)
  if (openDays.length === 0) return 'Closed every day'
  if (openDays.length === 7) return 'Open every day'
  return `${openDays.length} day${openDays.length === 1 ? '' : 's'} configured`
}

function extensionKey(row: StaffPhoneReadiness): string {
  return row.extension_id || `new:${row.user_id}`
}

function displayName(row: StaffPhoneReadiness): string {
  return row.display_name || row.user_name || row.user_email || row.user_id
}

function browserStatusLabel(row: StaffPhoneReadiness): string {
  if (row.ready_for_sofia_browser_transfer) return 'Ready'
  if (!row.extension_id) return 'No extension'
  const status = row.presence_status || 'offline'
  return `Browser phone ${status}`
}

function assignAddress(target: PortalAddress, value: PortalAddress | null | undefined): void {
  const next = cloneAddress(value)
  target.street = next.street
  target.city = next.city
  target.state = next.state
  target.zip = next.zip
  target.country = next.country
}

function assignHours(target: PortalHours, value: PortalHours | null | undefined): void {
  const next = createHoursShape(dayKeys, value)
  for (const dayKey of dayKeys) {
    target[dayKey] = {
      open: next[dayKey]?.open || '09:00',
      close: next[dayKey]?.close || '17:00',
      closed: next[dayKey]?.closed === true,
    }
  }
}

function hydrateBusinessDraft(
  settings: ClientPortalSettingsData,
  timezone: string | null,
  businessEmail: string | null,
): void {
  businessDraft.businessName = settings.businessName || ''
  businessDraft.description = settings.welcomeDescription || ''
  businessDraft.officePhone = settings.officePhone || ''
  businessDraft.businessEmail = businessEmail || ''
  businessDraft.website = settings.website || ''
  assignAddress(businessDraft.address, settings.address)
  businessDraft.walkInsPolicy = settings.walkInsPolicy || ''
  businessDraft.parkingNotes = settings.parkingNotes || ''
  businessDraft.directionsNotes = settings.directionsNotes || ''
  businessDraft.documentsNeededPolicy = settings.documentsNeededPolicy || ''
  businessDraft.paymentMethodsPolicy = settings.paymentMethodsPolicy || ''
  businessDraft.pricingPolicy = settings.pricingPolicy || ''
  businessDraft.refundPolicy = settings.refundPolicy || ''
  businessDraft.balancePaymentPolicy = settings.balancePaymentPolicy || ''
  businessDraft.showInsurance = settings.showInsurance
  businessDraft.showRealEstate = settings.showRealEstate
  businessDraft.showTaxResolution = settings.showTaxResolution
  businessDraft.showPersonalTaxPrepBrochure = settings.showPersonalTaxPrepBrochure
  businessDraft.showIncorporatingBrochure = settings.showIncorporatingBrochure
  businessDraft.showBookkeepingBrochure = settings.showBookkeepingBrochure
  businessDraft.showTaxResolutionBrochure = settings.showTaxResolutionBrochure
  businessLocations.value = cloneBusinessLocations(settings.locations)
  assignHours(publicHoursDraft, settings.hours)
  orgTimezone.value = timezone || ''
  hydrateAppointmentDrafts()
}

function buildAddressPayload(): PortalAddress | null {
  const address = cloneAddress(businessDraft.address)
  const hasAddress = Object.values(address).some((value) => value.trim())
  return hasAddress ? address : null
}

function ensureKnowledgeDraft(item: SofiaKnowledgeItem): KnowledgeDraft {
  const existing = knowledgeDrafts[item.id]
  if (existing) return existing
  const draft = {
    title: item.title,
    instructions: item.instructions,
    enabled: item.enabled,
  }
  knowledgeDrafts[item.id] = draft
  return draft
}

function ensureExtensionDraft(row: StaffPhoneReadiness): ExtensionDraft {
  const key = extensionKey(row)
  const existing = extensionDrafts[key]
  if (existing) return existing
  const draft = {
    extension: row.extension || '',
    displayName: row.display_name || '',
    isActive: row.is_active !== false,
    externalForwardingEnabled: row.external_forwarding_enabled === true,
    externalForwardingPhoneNumber: row.external_forwarding_phone_number || '',
  }
  extensionDrafts[key] = draft
  return draft
}

function hoursForDay(dayKey: DayKey): PortalHoursDay {
  if (!publicHoursDraft[dayKey]) {
    publicHoursDraft[dayKey] = { open: '09:00', close: '17:00', closed: true }
  }
  return publicHoursDraft[dayKey]
}

function resetNewKnowledge(): void {
  newKnowledge.title = ''
  newKnowledge.instructions = ''
  newKnowledge.enabled = true
  addingKnowledge.value = false
}

async function refreshRoutes(): Promise<void> {
  routes.value = await listPhoneRoutes()
  sofiaDefaultLanguage.value = normalizeEditableSofiaLanguage(routes.value[0]?.defaultLanguage)
}

async function refreshWebrtcStatus(): Promise<void> {
  webrtcStatus.value = await loadWebrtcStatus()
}

async function refreshBusinessSettings(force = false): Promise<void> {
  loadingBusiness.value = true
  errorMessage.value = null
  try {
    const loaded = await loadClientPortalSettings(dayKeys, { force })
    const communication = await loadCommunicationSettings()
    hydrateBusinessDraft(loaded.settings, loaded.orgTimezone, communication.settings.defaultSenderEmail)
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to load business info')
  } finally {
    loadingBusiness.value = false
  }
}

async function refreshKnowledge(): Promise<void> {
  loadingKnowledge.value = true
  errorMessage.value = null
  try {
    const items = await loadSofiaKnowledgeItems()
    knowledgeItems.value = items
    items.forEach((item) => {
      knowledgeDrafts[item.id] = {
        title: item.title,
        instructions: item.instructions,
        enabled: item.enabled,
      }
    })
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to load Sofia knowledge')
  } finally {
    loadingKnowledge.value = false
  }
}

async function refreshExtensions(): Promise<void> {
  loadingExtensions.value = true
  errorMessage.value = null
  try {
    const rows = await loadStaffPhoneReadiness()
    extensions.value = rows
    rows.forEach((row) => {
      extensionDrafts[extensionKey(row)] = {
        extension: row.extension || '',
        displayName: row.display_name || '',
        isActive: row.is_active !== false,
        externalForwardingEnabled: row.external_forwarding_enabled === true,
        externalForwardingPhoneNumber: row.external_forwarding_phone_number || '',
      }
    })
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to load extensions')
  } finally {
    loadingExtensions.value = false
  }
}

async function refreshAppointments(): Promise<void> {
  loadingAppointments.value = true
  errorMessage.value = null
  try {
    await loadEvents()
    await loadTeamMembers()
    await refreshBusinessSettings(true)
    hydrateAppointmentDrafts()
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to load appointment settings')
  } finally {
    loadingAppointments.value = false
  }
}

async function refreshOverview(): Promise<void> {
  loadingOverview.value = true
  errorMessage.value = null
  try {
    await refreshRoutes()
    await refreshWebrtcStatus()
    await refreshBusinessSettings(false)
    await loadEvents()
    await refreshKnowledge()
    await refreshExtensions()
    hydrateAppointmentDrafts()
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to load Sofia settings')
  } finally {
    loadingOverview.value = false
  }
}

async function refreshForActiveSection(): Promise<void> {
  const section = activeSection()
  if (section === 'business-info') {
    await refreshBusinessSettings(true)
    return
  }
  if (section === 'hours-language') {
    await refreshBusinessSettings(true)
    return
  }
  if (section === 'appointments') {
    await refreshAppointments()
    return
  }
  if (section === 'things-sofia-should-know') {
    await refreshKnowledge()
    return
  }
  if (section === 'extensions') {
    await refreshExtensions()
    return
  }
  if (section === 'voicemail') return
  await refreshOverview()
}

function buildLocationsWithAppointmentMappings(): PortalBusinessLocation[] {
  return businessLocations.value.map((location) => {
    const key = locationDraftKey(location)
    const bookingEventIds = activeBookingEvents.value
      .filter((event) => appointmentLocationDrafts[event.id]?.includes(key))
      .map((event) => event.id)
    return {
      ...location,
      address: cloneAddress(location.address),
      hours: location.hours ? createHoursShape(dayKeys, location.hours) : null,
      bookingEventIds,
    }
  })
}

async function saveAppointmentSettings(): Promise<void> {
  savingAppointments.value = true
  errorMessage.value = null
  try {
    for (const event of activeBookingEvents.value) {
      const staffIds = appointmentStaffDrafts[event.id] || []
      await setEventTeamMembers(event.id, staffIds.length ? staffIds : null)
    }

    await apiService.put('/api/settings/org', {
      clientPortalLocations: buildLocationsWithAppointmentMappings(),
    })

    resetOrgSettingsCache()
    await refreshAppointments()
    showMessage('Saved')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to save appointment settings')
  } finally {
    savingAppointments.value = false
  }
}

async function saveBusinessInfo(): Promise<void> {
  savingBusiness.value = true
  errorMessage.value = null
  try {
    await apiService.put('/api/settings/org', {
      clientPortalBusinessName: cleanText(businessDraft.businessName),
      clientPortalWelcomeDescription: cleanText(businessDraft.description),
      clientPortalOfficePhone: cleanText(businessDraft.officePhone),
      senderEmail: cleanText(businessDraft.businessEmail),
      clientPortalWebsite: cleanText(businessDraft.website),
      clientPortalAddress: buildAddressPayload(),
      clientPortalWalkInsPolicy: cleanText(businessDraft.walkInsPolicy),
      clientPortalParkingNotes: cleanText(businessDraft.parkingNotes),
      clientPortalDirectionsNotes: cleanText(businessDraft.directionsNotes),
      clientPortalDocumentsNeededPolicy: cleanText(businessDraft.documentsNeededPolicy),
      clientPortalPaymentMethodsPolicy: cleanText(businessDraft.paymentMethodsPolicy),
      clientPortalPricingPolicy: cleanText(businessDraft.pricingPolicy),
      clientPortalRefundPolicy: cleanText(businessDraft.refundPolicy),
      clientPortalBalancePaymentPolicy: cleanText(businessDraft.balancePaymentPolicy),
      clientPortalShowInsurance: businessDraft.showInsurance,
      clientPortalShowRealEstate: businessDraft.showRealEstate,
      clientPortalShowTaxResolution: businessDraft.showTaxResolution,
      clientPortalShowPersonalTaxPrepBrochure: businessDraft.showPersonalTaxPrepBrochure,
      clientPortalShowIncorporatingBrochure: businessDraft.showIncorporatingBrochure,
      clientPortalShowBookkeepingBrochure: businessDraft.showBookkeepingBrochure,
      clientPortalShowTaxResolutionBrochure: businessDraft.showTaxResolutionBrochure,
    })
    resetOrgSettingsCache()
    await refreshBusinessSettings(true)
    showMessage('Saved')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to save business info')
  } finally {
    savingBusiness.value = false
  }
}

async function saveHoursAndTimezone(): Promise<void> {
  savingHours.value = true
  errorMessage.value = null
  try {
    const route = primaryRoute.value
    await apiService.put('/api/settings/org', {
      clientPortalHours: publicHoursDraft,
      timezone: cleanText(orgTimezone.value),
    })
    if (route) {
      await updatePhoneRouteRouting(
        route.id,
        {
          ...route.officeHours,
          timezone: cleanText(orgTimezone.value) || route.officeHours.timezone,
        },
        { defaultLanguage: sofiaDefaultLanguage.value },
      )
      await refreshRoutes()
    }
    resetOrgSettingsCache()
    await refreshBusinessSettings(true)
    showMessage('Saved')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to save hours and timezone')
  } finally {
    savingHours.value = false
  }
}

async function addKnowledge(): Promise<void> {
  const title = newKnowledge.title.trim()
  const instructions = newKnowledge.instructions.trim()
  if (!title || !instructions) {
    errorMessage.value = 'Title and what Sofia should know are required'
    return
  }

  savingKnowledgeId.value = 'new'
  errorMessage.value = null
  try {
    await createSofiaKnowledgeItem({
      title,
      instructions,
      enabled: newKnowledge.enabled,
    })
    resetNewKnowledge()
    await refreshKnowledge()
    showMessage('Saved')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to add what Sofia should know')
  } finally {
    savingKnowledgeId.value = null
  }
}

async function saveKnowledge(item: SofiaKnowledgeItem): Promise<void> {
  const draft = ensureKnowledgeDraft(item)
  const title = draft.title.trim()
  const instructions = draft.instructions.trim()
  if (!title || !instructions) {
    errorMessage.value = 'Title and what Sofia should know are required'
    return
  }

  savingKnowledgeId.value = item.id
  errorMessage.value = null
  try {
    await updateSofiaKnowledgeItem(item.id, {
      title,
      instructions,
      enabled: draft.enabled,
    })
    editingKnowledgeId.value = null
    await refreshKnowledge()
    showMessage('Saved')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to save what Sofia should know')
  } finally {
    savingKnowledgeId.value = null
  }
}

async function toggleKnowledge(item: SofiaKnowledgeItem): Promise<void> {
  savingKnowledgeId.value = item.id
  errorMessage.value = null
  try {
    await updateSofiaKnowledgeItem(item.id, { enabled: !item.enabled })
    await refreshKnowledge()
    showMessage('Saved')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to update Sofia knowledge')
  } finally {
    savingKnowledgeId.value = null
  }
}

async function deleteKnowledge(item: SofiaKnowledgeItem): Promise<void> {
  if (!window.confirm(`Delete "${item.title}"?`)) return
  deletingKnowledgeId.value = item.id
  errorMessage.value = null
  try {
    await deleteSofiaKnowledgeItem(item.id)
    await refreshKnowledge()
    showMessage('Deleted')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to delete what Sofia should know')
  } finally {
    deletingKnowledgeId.value = null
  }
}

async function saveExtension(row: StaffPhoneReadiness): Promise<void> {
  const draft = ensureExtensionDraft(row)
  const extension = draft.extension.trim()
  const displayNameValue = draft.displayName.trim()
  const forwardingPhoneNumber = draft.externalForwardingPhoneNumber.trim()

  if (!extension) {
    errorMessage.value = 'Extension number is required'
    return
  }
  if (draft.externalForwardingEnabled && !forwardingPhoneNumber) {
    errorMessage.value = 'Forwarding phone number is required when forwarding is on'
    return
  }

  const key = extensionKey(row)
  savingExtensionId.value = key
  errorMessage.value = null
  try {
    if (row.extension_id) {
      await updateUserExtension(row.extension_id, {
        extension,
        display_name: displayNameValue || null,
        is_active: draft.isActive,
        external_forwarding_enabled: draft.externalForwardingEnabled,
        external_forwarding_phone_number: draft.externalForwardingEnabled ? forwardingPhoneNumber : null,
      })
    } else {
      await createUserExtension({
        user_id: row.user_id,
        extension,
        display_name: displayNameValue || null,
        transfer_endpoint_type: 'WEBRTC',
        external_forwarding_enabled: draft.externalForwardingEnabled,
        external_forwarding_phone_number: draft.externalForwardingEnabled ? forwardingPhoneNumber : null,
      })
      await refreshExtensions()
      const created = extensions.value.find((candidate) => candidate.user_id === row.user_id && candidate.extension)
      if (created?.extension_id && !draft.isActive) {
        await updateUserExtension(created.extension_id, {
          is_active: draft.isActive,
        })
      }
    }
    await refreshExtensions()
    showMessage('Saved')
  } catch (error) {
    errorMessage.value = errorText(error, 'Unable to save extension')
  } finally {
    savingExtensionId.value = null
  }
}

watch(() => props.activeTab, () => {
  void refreshForActiveSection()
})

onMounted(() => {
  void refreshForActiveSection()
})
</script>

<template>
  <section class="sofia-settings">
    <header class="sofia-settings__header">
      <div>
        <h3>Sofia</h3>
        <p>Sofia uses these settings when answering calls for your business.</p>
      </div>
      <button
        type="button"
        class="sofia-settings__button"
        :disabled="loadingOverview || loadingBusiness || loadingAppointments || loadingKnowledge || loadingExtensions"
        @click="refreshForActiveSection"
      >
        <RefreshCw class="sofia-settings__icon" />
        Refresh
      </button>
    </header>

    <p v-if="errorMessage" class="sofia-settings__error">{{ errorMessage }}</p>
    <p v-if="successMessage" class="sofia-settings__success">{{ successMessage }}</p>

    <template v-if="activeSection() === 'overview'">
      <section class="sofia-settings__overview" aria-label="Sofia overview">
        <div>
          <span>Sofia number</span>
          <strong>{{ primaryRoute?.phoneE164 || 'Not configured' }}</strong>
        </div>
        <div>
          <span>Sofia status</span>
          <strong>{{ primaryRoute?.status === 'active' ? 'Enabled' : 'Not active' }}</strong>
        </div>
        <div>
          <span>Default language</span>
          <strong>{{ languageLabel(primaryRoute?.defaultLanguage) }}</strong>
        </div>
        <div>
          <span>Phone system status</span>
          <strong>{{ webrtcStatus?.phone_webrtc_enabled ? 'Browser phone enabled' : 'Browser phone off' }}</strong>
        </div>
        <div>
          <span>Business hours</span>
          <strong>{{ publicHoursSummary(publicHoursDraft) }}</strong>
        </div>
        <div>
          <span>Appointments Sofia can book</span>
          <strong>{{ appointmentTypeCount }} types</strong>
        </div>
        <div>
          <span>Timezone</span>
          <strong>{{ orgTimezone || 'Not configured' }}</strong>
        </div>
        <div>
          <span>Things Sofia should know</span>
          <strong>{{ enabledKnowledgeCount }} enabled</strong>
        </div>
        <div>
          <span>Extensions ready</span>
          <strong>{{ readyBrowserExtensionCount }} of {{ activeExtensionCount }}</strong>
        </div>
        <div>
          <span>Forwarding</span>
          <strong>{{ forwardingEnabledCount }} on</strong>
        </div>
      </section>

      <section class="sofia-settings__section">
        <h4>Business Info</h4>
        <dl class="sofia-settings__definition-grid">
          <div>
            <dt>Business name</dt>
            <dd>{{ businessDraft.businessName || 'Not configured' }}</dd>
          </div>
          <div>
            <dt>Business phone callers can use</dt>
            <dd>{{ businessDraft.officePhone || 'Not configured' }}</dd>
          </div>
          <div>
            <dt>Business email</dt>
            <dd>{{ businessDraft.businessEmail || 'Not configured' }}</dd>
          </div>
          <div>
            <dt>Website</dt>
            <dd>{{ businessDraft.website || 'Not configured' }}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{{ addressLine(businessDraft.address) }}</dd>
          </div>
        </dl>
      </section>
    </template>

    <template v-else-if="activeSection() === 'business-info'">
      <section class="sofia-settings__section">
        <div class="sofia-settings__section-header">
          <div>
            <h4>Business Info Sofia Uses</h4>
            <p>Business details Sofia can use when answering common caller questions.</p>
          </div>
          <button type="button" class="sofia-settings__button is-primary" :disabled="savingBusiness" @click="saveBusinessInfo">
            <Save class="sofia-settings__icon" />
            {{ savingBusiness ? 'Saving...' : 'Save' }}
          </button>
        </div>

        <p v-if="loadingBusiness" class="sofia-settings__muted">Loading business info...</p>

        <form class="sofia-settings__form" @submit.prevent="saveBusinessInfo">
          <div class="sofia-settings__form-grid">
            <label>
              <span>Business name</span>
              <input v-model="businessDraft.businessName" type="text" maxlength="160" />
            </label>
            <label>
              <span>Business phone callers can use</span>
              <input v-model="businessDraft.officePhone" type="tel" maxlength="40" />
            </label>
            <label>
              <span>Business email</span>
              <input v-model="businessDraft.businessEmail" type="email" maxlength="320" />
            </label>
            <label>
              <span>Website</span>
              <input v-model="businessDraft.website" type="url" maxlength="500" />
            </label>
          </div>

          <label>
            <span>Business description</span>
            <textarea v-model="businessDraft.description" rows="3" maxlength="1000" />
          </label>

          <div class="sofia-settings__form-grid">
            <label>
              <span>Street</span>
              <input v-model="businessDraft.address.street" type="text" maxlength="200" />
            </label>
            <label>
              <span>City</span>
              <input v-model="businessDraft.address.city" type="text" maxlength="120" />
            </label>
            <label>
              <span>State</span>
              <input v-model="businessDraft.address.state" type="text" maxlength="80" />
            </label>
            <label>
              <span>ZIP</span>
              <input v-model="businessDraft.address.zip" type="text" maxlength="40" />
            </label>
            <label>
              <span>Country</span>
              <input v-model="businessDraft.address.country" type="text" maxlength="80" />
            </label>
          </div>

          <div class="sofia-settings__form-grid">
            <label>
              <span>Walk-ins</span>
              <textarea v-model="businessDraft.walkInsPolicy" rows="3" maxlength="1000" />
            </label>
            <label>
              <span>What documents should clients bring or upload?</span>
              <textarea
                v-model="businessDraft.documentsNeededPolicy"
                rows="3"
                maxlength="1000"
                placeholder="Example: New tax clients should bring ID, Social Security cards, W-2s, 1099s, prior-year return, and any IRS letters."
              />
            </label>
            <label>
              <span>Payment methods</span>
              <textarea v-model="businessDraft.paymentMethodsPolicy" rows="3" maxlength="1000" />
            </label>
            <label>
              <span>Pricing</span>
              <textarea v-model="businessDraft.pricingPolicy" rows="3" maxlength="1000" />
            </label>
            <label>
              <span>Refunds</span>
              <textarea v-model="businessDraft.refundPolicy" rows="3" maxlength="1000" />
            </label>
            <label>
              <span>What should Sofia say about balances and payments?</span>
              <textarea
                v-model="businessDraft.balancePaymentPolicy"
                rows="3"
                maxlength="1000"
                placeholder="Example: Clients can pay balances through the client portal. For balance questions, Sofia should offer to take a message for staff."
              />
            </label>
            <label>
              <span>Parking</span>
              <textarea v-model="businessDraft.parkingNotes" rows="3" maxlength="1000" />
            </label>
            <label>
              <span>Directions</span>
              <textarea v-model="businessDraft.directionsNotes" rows="3" maxlength="1000" />
            </label>
          </div>

          <fieldset class="sofia-settings__fieldset">
            <legend>Service sections</legend>
            <label class="sofia-settings__checkbox">
              <input v-model="businessDraft.showInsurance" type="checkbox" />
              <span>Insurance</span>
            </label>
            <label class="sofia-settings__checkbox">
              <input v-model="businessDraft.showRealEstate" type="checkbox" />
              <span>Real estate</span>
            </label>
            <label class="sofia-settings__checkbox">
              <input v-model="businessDraft.showTaxResolution" type="checkbox" />
              <span>Tax resolution</span>
            </label>
            <label class="sofia-settings__checkbox">
              <input v-model="businessDraft.showPersonalTaxPrepBrochure" type="checkbox" />
              <span>Personal tax prep</span>
            </label>
            <label class="sofia-settings__checkbox">
              <input v-model="businessDraft.showIncorporatingBrochure" type="checkbox" />
              <span>Incorporating</span>
            </label>
            <label class="sofia-settings__checkbox">
              <input v-model="businessDraft.showBookkeepingBrochure" type="checkbox" />
              <span>Bookkeeping</span>
            </label>
            <label class="sofia-settings__checkbox">
              <input v-model="businessDraft.showTaxResolutionBrochure" type="checkbox" />
              <span>Tax resolution brochure</span>
            </label>
            <p class="sofia-settings__muted">Enabled now: {{ enabledServiceLabels.join(', ') || 'None' }}</p>
          </fieldset>
        </form>
      </section>
    </template>

    <template v-else-if="activeSection() === 'hours-language'">
      <section class="sofia-settings__section">
        <div class="sofia-settings__section-header">
          <div>
            <h4>Hours & Language</h4>
            <p>Public business hours and default language Sofia can use during calls.</p>
          </div>
          <button type="button" class="sofia-settings__button is-primary" :disabled="savingHours" @click="saveHoursAndTimezone">
            <Save class="sofia-settings__icon" />
            {{ savingHours ? 'Saving...' : 'Save' }}
          </button>
        </div>

        <section class="sofia-settings__subsection">
          <h5>Default language</h5>
          <dl class="sofia-settings__definition-grid">
            <div>
              <dt>Sofia default language</dt>
              <dd>
                <select v-model="sofiaDefaultLanguage" class="sofia-settings__input">
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                </select>
              </dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>
                <input v-model="orgTimezone" class="sofia-settings__input" type="text" placeholder="America/Los_Angeles" />
              </dd>
            </div>
          </dl>
        </section>

        <form class="sofia-settings__form" @submit.prevent="saveHoursAndTimezone">
          <section class="sofia-settings__subsection">
            <h5>Business hours</h5>
            <div class="sofia-settings__hours-list">
              <div v-for="dayKey in dayKeys" :key="dayKey" class="sofia-settings__hours-row">
                <label class="sofia-settings__checkbox">
                  <input v-model="hoursForDay(dayKey).closed" type="checkbox" />
                  <span>{{ dayLabels[dayKey] }} closed</span>
                </label>
                <input v-model="hoursForDay(dayKey).open" type="time" :disabled="hoursForDay(dayKey).closed" />
                <input v-model="hoursForDay(dayKey).close" type="time" :disabled="hoursForDay(dayKey).closed" />
              </div>
            </div>
          </section>
        </form>
      </section>
    </template>

    <template v-else-if="activeSection() === 'appointments'">
      <section class="sofia-settings__section">
        <div class="sofia-settings__section-header">
          <div>
            <h4>Appointments Sofia Can Book</h4>
            <p>Choose which appointment types Sofia can offer, who can take them, and which locations use them.</p>
          </div>
          <button type="button" class="sofia-settings__button is-primary" :disabled="savingAppointments" @click="saveAppointmentSettings">
            <Save class="sofia-settings__icon" />
            {{ savingAppointments ? 'Saving...' : 'Save' }}
          </button>
        </div>

        <p v-if="loadingAppointments" class="sofia-settings__muted">Loading appointment settings...</p>
        <p v-else-if="activeBookingEvents.length === 0" class="sofia-settings__muted">No active appointment types found. Add appointment types in Calendar settings first.</p>

        <div v-else class="sofia-settings__appointment-list">
          <article v-for="event in activeBookingEvents" :key="event.id" class="sofia-settings__appointment-row">
            <div class="sofia-settings__appointment-heading">
              <div>
                <h5>{{ bookingEventLabel(event) }}</h5>
                <p>{{ event.duration_minutes ? `${event.duration_minutes} minutes` : 'Duration not set' }}</p>
              </div>
              <span class="sofia-settings__status">
                {{ appointmentStaffCount(event.id) }} staff · {{ appointmentLocationCount(event.id) }} locations
              </span>
            </div>

            <div class="sofia-settings__assignment-grid">
              <fieldset class="sofia-settings__fieldset">
                <legend>Staff who can take this appointment</legend>
                <p v-if="bookableTeamMembers.length === 0" class="sofia-settings__muted">No bookable staff found.</p>
                <label
                  v-for="member in bookableTeamMembers"
                  :key="member.id"
                  class="sofia-settings__checkbox"
                >
                  <input
                    type="checkbox"
                    :checked="appointmentStaffDrafts[event.id]?.includes(member.id)"
                    @change="toggleDraftValue(appointmentStaffDrafts, event.id, member.id, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ bookingTeamMemberLabel(member) }}</span>
                </label>
              </fieldset>

              <fieldset class="sofia-settings__fieldset">
                <legend>Locations for this appointment</legend>
                <p v-if="activeBusinessLocations.length === 0" class="sofia-settings__muted">No active business locations found.</p>
                <label
                  v-for="location in activeBusinessLocations"
                  :key="locationDraftKey(location)"
                  class="sofia-settings__checkbox"
                >
                  <input
                    type="checkbox"
                    :checked="appointmentLocationDrafts[event.id]?.includes(locationDraftKey(location))"
                    @change="toggleDraftValue(appointmentLocationDrafts, event.id, locationDraftKey(location), ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ locationLabel(location) }}</span>
                </label>
              </fieldset>
            </div>
          </article>
        </div>
      </section>
    </template>

    <template v-else-if="activeSection() === 'things-sofia-should-know'">
      <section class="sofia-settings__section">
        <div class="sofia-settings__section-header">
          <div>
            <h4>Things Sofia Should Know</h4>
            <p>Add temporary updates, promotions, or business details Sofia should use when answering calls.</p>
          </div>
          <button type="button" class="sofia-settings__button" @click="addingKnowledge = true">
            <Plus class="sofia-settings__icon" />
            Add what Sofia should know
          </button>
        </div>

        <form v-if="addingKnowledge" class="sofia-settings__form" @submit.prevent="addKnowledge">
          <label>
            <span>Title</span>
            <input v-model="newKnowledge.title" type="text" maxlength="120" />
          </label>
          <label>
            <span>What should Sofia know?</span>
            <textarea v-model="newKnowledge.instructions" maxlength="2000" rows="4" />
          </label>
          <label class="sofia-settings__checkbox">
            <input v-model="newKnowledge.enabled" type="checkbox" />
            <span>Enabled</span>
          </label>
          <div class="sofia-settings__form-actions">
            <button type="submit" class="sofia-settings__button is-primary" :disabled="savingKnowledgeId === 'new'">
              <Save class="sofia-settings__icon" />
              Save
            </button>
            <button type="button" class="sofia-settings__button" @click="resetNewKnowledge">
              <X class="sofia-settings__icon" />
              Cancel
            </button>
          </div>
        </form>

        <p v-if="loadingKnowledge && knowledgeItems.length === 0" class="sofia-settings__muted">Loading...</p>
        <p v-else-if="knowledgeItems.length === 0" class="sofia-settings__muted">Add something Sofia should know, like a current promotion, office update, or special instruction.</p>

        <div v-else class="sofia-settings__knowledge-list">
          <article v-for="item in knowledgeItems" :key="item.id" class="sofia-settings__knowledge-row">
            <template v-if="editingKnowledgeId === item.id">
              <label>
                <span>Title</span>
                <input v-model="ensureKnowledgeDraft(item).title" type="text" maxlength="120" />
              </label>
              <label>
                <span>What should Sofia know?</span>
                <textarea v-model="ensureKnowledgeDraft(item).instructions" maxlength="2000" rows="4" />
              </label>
              <label class="sofia-settings__checkbox">
                <input v-model="ensureKnowledgeDraft(item).enabled" type="checkbox" />
                <span>Enabled</span>
              </label>
              <div class="sofia-settings__row-actions">
                <button type="button" class="sofia-settings__icon-button" :disabled="savingKnowledgeId === item.id" aria-label="Save" @click="saveKnowledge(item)">
                  <Save class="sofia-settings__icon" />
                </button>
                <button type="button" class="sofia-settings__icon-button" aria-label="Cancel" @click="editingKnowledgeId = null">
                  <X class="sofia-settings__icon" />
                </button>
              </div>
            </template>
            <template v-else>
              <div class="sofia-settings__knowledge-content">
                <div>
                  <h5>{{ item.title }}</h5>
                  <p>{{ item.instructions }}</p>
                </div>
                <span class="sofia-settings__status" :class="{ 'is-off': !item.enabled }">
                  <CheckCircle2 v-if="item.enabled" class="sofia-settings__icon" />
                  {{ item.enabled ? 'Enabled' : 'Disabled' }}
                </span>
              </div>
              <div class="sofia-settings__row-actions">
                <button type="button" class="sofia-settings__text-button" :disabled="savingKnowledgeId === item.id" @click="toggleKnowledge(item)">
                  {{ item.enabled ? 'Disable' : 'Enable' }}
                </button>
                <button type="button" class="sofia-settings__icon-button" aria-label="Edit" @click="editingKnowledgeId = item.id">
                  <Pencil class="sofia-settings__icon" />
                </button>
                <button type="button" class="sofia-settings__icon-button" :disabled="deletingKnowledgeId === item.id" aria-label="Delete" @click="deleteKnowledge(item)">
                  <Trash2 class="sofia-settings__icon" />
                </button>
              </div>
            </template>
          </article>
        </div>
      </section>
    </template>

    <template v-else-if="activeSection() === 'extensions'">
      <section class="sofia-settings__section">
        <div class="sofia-settings__section-header">
          <div>
            <h4>Extensions & Forwarding</h4>
            <p>Forward calls to a regular phone number when Sofia transfers a caller to this extension.</p>
          </div>
        </div>

        <p v-if="loadingExtensions && extensions.length === 0" class="sofia-settings__muted">Loading...</p>
        <p v-else-if="extensions.length === 0" class="sofia-settings__muted">No staff phone users found.</p>

        <div v-else class="sofia-settings__table-wrap">
          <table class="sofia-settings__table">
            <thead>
              <tr>
                <th>Extension</th>
                <th>Name</th>
                <th>Browser phone</th>
                <th>Active</th>
                <th>Forward calls</th>
                <th>Forwarding phone number</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in extensions" :key="extensionKey(row)">
                <td>
                  <input v-model="ensureExtensionDraft(row).extension" class="sofia-settings__input" type="text" maxlength="16" />
                </td>
                <td>
                  <input v-model="ensureExtensionDraft(row).displayName" class="sofia-settings__input" type="text" maxlength="160" :placeholder="displayName(row)" />
                  <span>{{ row.user_email }}</span>
                </td>
                <td>{{ browserStatusLabel(row) }}</td>
                <td>
                  <label class="sofia-settings__checkbox">
                    <input v-model="ensureExtensionDraft(row).isActive" type="checkbox" />
                    <span>{{ ensureExtensionDraft(row).isActive ? 'Active' : 'Inactive' }}</span>
                  </label>
                </td>
                <td>
                  <label class="sofia-settings__checkbox">
                    <input v-model="ensureExtensionDraft(row).externalForwardingEnabled" type="checkbox" />
                    <span>{{ ensureExtensionDraft(row).externalForwardingEnabled ? 'On' : 'Off' }}</span>
                  </label>
                </td>
                <td>
                  <input
                    v-model="ensureExtensionDraft(row).externalForwardingPhoneNumber"
                    class="sofia-settings__input"
                    type="tel"
                    placeholder="+16195551212"
                  />
                  <span>Turn forwarding on, enter the phone number, then save.</span>
                </td>
                <td>
                  <button
                    type="button"
                    class="sofia-settings__button"
                    :disabled="savingExtensionId === extensionKey(row)"
                    @click="saveExtension(row)"
                  >
                    <Save class="sofia-settings__icon" />
                    Save
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <template v-else>
      <section class="sofia-settings__section">
        <div class="sofia-settings__section-header">
          <div>
            <h4>Voicemail Greeting</h4>
            <p>Use the same greeting controls shown on the Phone page.</p>
          </div>
        </div>
        <PhoneVoicemailGreetingPanel />
      </section>
    </template>
  </section>
</template>

<style scoped>
.sofia-settings {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.sofia-settings__header,
.sofia-settings__section-header,
.sofia-settings__knowledge-content,
.sofia-settings__appointment-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.sofia-settings__header h3,
.sofia-settings__section h4,
.sofia-settings__subsection h5,
.sofia-settings__knowledge-row h5,
.sofia-settings__appointment-row h5 {
  margin: 0;
  color: var(--settings-text, #111827);
}

.sofia-settings__header h3 {
  font-size: 20px;
  line-height: 1.25;
}

.sofia-settings__section h4 {
  font-size: 18px;
  line-height: 1.3;
}

.sofia-settings__subsection h5,
.sofia-settings__knowledge-row h5,
.sofia-settings__appointment-row h5 {
  font-size: 15px;
  line-height: 1.35;
}

.sofia-settings__header p,
.sofia-settings__section p,
.sofia-settings__muted,
.sofia-settings__table span {
  margin: 4px 0 0;
  color: var(--settings-text-muted, #6b7280);
  font-size: 13px;
  line-height: 1.5;
}

.sofia-settings__overview,
.sofia-settings__definition-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.sofia-settings__overview > div,
.sofia-settings__definition-grid > div {
  border: 1px solid var(--settings-border, #e5e7eb);
  border-radius: 8px;
  padding: 14px;
}

.sofia-settings__overview span,
.sofia-settings__definition-grid dt {
  display: block;
  color: var(--settings-text-muted, #6b7280);
  font-size: 12px;
  font-weight: 600;
}

.sofia-settings__overview strong,
.sofia-settings__definition-grid dd {
  display: block;
  margin: 6px 0 0;
  color: var(--settings-text, #111827);
  font-size: 16px;
  font-weight: 700;
}

.sofia-settings__section,
.sofia-settings__subsection {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sofia-settings__section {
  border-top: 1px solid var(--settings-border, #e5e7eb);
  padding-top: 18px;
}

.sofia-settings__subsection {
  border-top: 1px solid var(--settings-border, #e5e7eb);
  padding-top: 16px;
}

.sofia-settings__button,
.sofia-settings__icon-button,
.sofia-settings__text-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--settings-border, #d1d5db);
  border-radius: 6px;
  background: var(--settings-surface-panel, #ffffff);
  color: var(--settings-text, #111827);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.sofia-settings__button {
  min-height: 36px;
  padding: 0 12px;
}

.sofia-settings__button.is-primary {
  border-color: var(--settings-brand, #2563eb);
  background: var(--settings-brand, #2563eb);
  color: #ffffff;
}

.sofia-settings__icon-button {
  width: 34px;
  height: 34px;
  padding: 0;
}

.sofia-settings__text-button {
  min-height: 34px;
  padding: 0 10px;
}

.sofia-settings__button:disabled,
.sofia-settings__icon-button:disabled,
.sofia-settings__text-button:disabled,
.sofia-settings__input:disabled,
.sofia-settings__hours-row input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.sofia-settings__icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

.sofia-settings__error,
.sofia-settings__success {
  margin: 0;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
}

.sofia-settings__error {
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #991b1b;
}

.sofia-settings__success {
  border: 1px solid #bbf7d0;
  background: #f0fdf4;
  color: #166534;
}

.sofia-settings__form,
.sofia-settings__knowledge-row,
.sofia-settings__appointment-row {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--settings-border, #e5e7eb);
  padding-top: 14px;
}

.sofia-settings__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.sofia-settings__form label,
.sofia-settings__knowledge-row label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sofia-settings__form label > span,
.sofia-settings__knowledge-row label > span,
.sofia-settings__fieldset legend {
  color: var(--settings-text, #111827);
  font-size: 13px;
  font-weight: 600;
}

.sofia-settings__form input,
.sofia-settings__form textarea,
.sofia-settings__knowledge-row input,
.sofia-settings__knowledge-row textarea,
.sofia-settings__input,
.sofia-settings__hours-row input {
  width: 100%;
  min-height: 36px;
  border: 1px solid var(--settings-border, #d1d5db);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--settings-text, #111827);
  font: inherit;
  background: var(--settings-surface-panel, #ffffff);
}

.sofia-settings__form textarea,
.sofia-settings__knowledge-row textarea {
  resize: vertical;
}

.sofia-settings__fieldset {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  border: 1px solid var(--settings-border, #e5e7eb);
  border-radius: 8px;
  padding: 14px;
}

.sofia-settings__fieldset legend {
  padding: 0 4px;
}

.sofia-settings__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--settings-text, #111827);
  font-size: 13px;
}

.sofia-settings__checkbox input {
  width: 16px;
  height: 16px;
}

.sofia-settings__form-actions,
.sofia-settings__row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.sofia-settings__knowledge-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.sofia-settings__appointment-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sofia-settings__assignment-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.sofia-settings__knowledge-content p {
  white-space: pre-wrap;
}

.sofia-settings__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #166534;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.sofia-settings__status.is-off {
  color: var(--settings-text-muted, #6b7280);
}

.sofia-settings__hours-list {
  display: grid;
  gap: 8px;
}

.sofia-settings__hours-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(120px, 160px) minmax(120px, 160px);
  align-items: center;
  gap: 10px;
}

.sofia-settings__table-wrap {
  width: 100%;
  overflow-x: auto;
}

.sofia-settings__table {
  width: 100%;
  min-width: 1040px;
  border-collapse: collapse;
}

.sofia-settings__table th,
.sofia-settings__table td {
  border-top: 1px solid var(--settings-border, #e5e7eb);
  padding: 10px 8px;
  text-align: left;
  vertical-align: middle;
  color: var(--settings-text, #111827);
  font-size: 13px;
}

.sofia-settings__table th {
  color: var(--settings-text-muted, #6b7280);
  font-weight: 700;
}

.sofia-settings__table td span {
  display: block;
}

@media (max-width: 900px) {
  .sofia-settings__overview,
  .sofia-settings__definition-grid,
  .sofia-settings__form-grid {
    grid-template-columns: 1fr;
  }

  .sofia-settings__assignment-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .sofia-settings__header,
  .sofia-settings__section-header,
  .sofia-settings__knowledge-content,
  .sofia-settings__appointment-heading {
    flex-direction: column;
    align-items: stretch;
  }

  .sofia-settings__hours-row {
    grid-template-columns: 1fr;
  }
}
</style>
