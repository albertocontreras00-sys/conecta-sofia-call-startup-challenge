import { computed, nextTick, onUnmounted, ref, shallowRef } from 'vue'
import { useSofiaAvatar } from '@/composables/useSofiaAvatar'
import { usePermissionsStore } from '@/stores/permissions'
import apiService from '@/services/api'
import { readValidatedOrgContext } from '@/utils/orgContextSession'
import { API_BASE } from '@/utils/apiConfig'
import type {
  SofiaChatApiResponse,
  SofiaFeedbackApiResponse,
  SofiaMessage
} from '@/types/sofia'

type SofiaSupportMode = 'select' | 'text'
type FeedbackRating = 1 | -1

interface UseSofiaSupportChatOptions {
  scrollMessagesToBottom: () => void
}

const SESSION_STORAGE_KEY = 'sofia_modal_session_id'
const SOFIA_CLIENT = 'sofia-modal'

function getSessionId(): string {
  if (typeof window === 'undefined') return ''

  let value = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (!value) {
    value = crypto.randomUUID()
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, value)
  }
  return value
}

export function useSofiaSupportChat(options: UseSofiaSupportChatOptions) {
  const permissionsStore = usePermissionsStore()
  const {
    avatarSrc,
    currentState,
    setIdle,
    setThinking,
    flashSuccess,
    flashError
  } = useSofiaAvatar({ variant: 'general' })

  const mode = shallowRef<SofiaSupportMode>('select')
  const lang = shallowRef('en-US')
  const textInput = shallowRef('')
  const isBusy = shallowRef(false)
  const error = shallowRef('')
  const lastRequestId = shallowRef('')
  const feedbackRating = shallowRef<FeedbackRating | null>(null)
  const feedbackMessage = shallowRef('')
  const feedbackSubmitting = shallowRef(false)
  const sessionId = shallowRef(getSessionId())
  const messages = ref<SofiaMessage[]>([])

  const avatarAnimationClass = computed(() => ({
    'is-thinking': currentState.value === 'thinking'
  }))

  const statusBadgeClass = computed(() => ({
    'is-active': isBusy.value
  }))

  const statusText = computed(() => (isBusy.value ? 'Thinking...' : 'Sofia AI'))

  function getOrgId(): string | null {
    return permissionsStore.orgId || readValidatedOrgContext()?.orgId || localStorage.getItem('currentOrgId') || null
  }

  async function getRequestContext(): Promise<{ authHeader: string; orgId: string | null }> {
    const headers = await apiService.getAuthHeaders() as Record<string, string>
    return {
      authHeader: headers.Authorization || '',
      orgId: headers['x-org-id'] || getOrgId()
    }
  }

  function scrollMessagesToBottom(): void {
    nextTick(() => {
      options.scrollMessagesToBottom()
    })
  }

  function resetState(): void {
    error.value = ''
    lastRequestId.value = ''
    feedbackRating.value = null
    feedbackMessage.value = ''
    messages.value = []
    textInput.value = ''
    setIdle()
  }

  function selectTextMode(): void {
    mode.value = 'text'
    resetState()
  }

  function goBack(): void {
    mode.value = 'select'
    resetState()
  }

  function resetToSelection(): void {
    resetState()
    mode.value = 'select'
  }

  async function sendTextMessage(): Promise<void> {
    const text = textInput.value.trim()
    if (!text || isBusy.value) return

    const { authHeader, orgId } = await getRequestContext()
    if (!authHeader) {
      error.value = 'Please log in to use Sofia.'
      return
    }
    if (!orgId) {
      error.value = 'Select an organization to chat with Sofia.'
      return
    }

    messages.value.push({ role: 'user', content: text })
    textInput.value = ''
    error.value = ''
    isBusy.value = true
    setThinking()
    scrollMessagesToBottom()

    const requestId = crypto.randomUUID()

    try {
      const res = await fetch(`${API_BASE}/api/sofia/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
          'x-org-id': orgId,
          'x-request-id': requestId,
          'x-sofia-client': SOFIA_CLIENT
        },
        body: JSON.stringify({
          message: text,
          language: lang.value,
          source: SOFIA_CLIENT,
          page_path: window.location.pathname,
          org_id: orgId,
          session_id: sessionId.value
        })
      })

      if (!res.ok) {
        const responseText = await res.text().catch(() => '')
        throw new Error(`Request failed (${res.status}). ${responseText}`)
      }

      const data = (await res.json()) as SofiaChatApiResponse
      const reply = String(data?.assistant_text || '').trim()
      if (!reply) {
        throw new Error('Sofia did not return a response. Please try again.')
      }

      messages.value.push({ role: 'assistant', content: reply })
      lastRequestId.value = data.interaction_id || data.request_id || requestId
      feedbackRating.value = null
      feedbackMessage.value = ''
      flashSuccess(1500)
      scrollMessagesToBottom()
    } catch (caught: unknown) {
      error.value = caught instanceof Error ? caught.message : 'Failed to send message.'
      flashError(2000)
    } finally {
      isBusy.value = false
    }
  }

  async function sendFeedback(rating: FeedbackRating): Promise<void> {
    if (!lastRequestId.value || feedbackSubmitting.value) return

    const { authHeader, orgId } = await getRequestContext()
    feedbackSubmitting.value = true
    feedbackMessage.value = ''

    try {
      const res = await fetch(`${API_BASE}/api/sofia/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
          ...(orgId ? { 'x-org-id': orgId } : {}),
          'x-sofia-client': SOFIA_CLIENT
        },
        body: JSON.stringify({
          interaction_id: lastRequestId.value,
          request_id: lastRequestId.value,
          rating,
          source: SOFIA_CLIENT,
          org_id: orgId
        })
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `Feedback failed (${res.status})`)
      }

      await res.json().catch(() => null as SofiaFeedbackApiResponse | null)
      feedbackRating.value = rating
      feedbackMessage.value = rating === 1 ? 'Thanks!' : "We'll improve."
    } catch (caught: unknown) {
      feedbackMessage.value = caught instanceof Error ? caught.message : 'Feedback failed.'
    } finally {
      feedbackSubmitting.value = false
    }
  }

  onUnmounted(() => {
    setIdle()
  })

  return {
    avatarSrc,
    avatarAnimationClass,
    statusBadgeClass,
    statusText,
    mode,
    lang,
    textInput,
    messages,
    isBusy,
    error,
    lastRequestId,
    feedbackRating,
    feedbackMessage,
    feedbackSubmitting,
    selectTextMode,
    goBack,
    resetState,
    resetToSelection,
    sendTextMessage,
    sendFeedback
  }
}
