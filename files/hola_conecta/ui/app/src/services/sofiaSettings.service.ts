import apiService from '@/services/api'

export interface SofiaKnowledgeItem {
  id: string
  title: string
  instructions: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
}

export interface SofiaKnowledgeInput {
  title: string
  instructions: string
  enabled: boolean
}

interface KnowledgeListResponse {
  success: boolean
  data: {
    knowledgeItems: SofiaKnowledgeItem[]
  }
}

interface KnowledgeMutationResponse {
  success: boolean
  data: {
    knowledgeItem: SofiaKnowledgeItem
  }
}

export async function loadSofiaKnowledgeItems(): Promise<SofiaKnowledgeItem[]> {
  const response = await apiService.get<KnowledgeListResponse>('/api/settings/sofia/knowledge')
  return response.data.knowledgeItems
}

export async function createSofiaKnowledgeItem(input: SofiaKnowledgeInput): Promise<SofiaKnowledgeItem> {
  const response = await apiService.post<KnowledgeMutationResponse>('/api/settings/sofia/knowledge', input)
  return response.data.knowledgeItem
}

export async function updateSofiaKnowledgeItem(id: string, input: Partial<SofiaKnowledgeInput>): Promise<SofiaKnowledgeItem> {
  const response = await apiService.patch<KnowledgeMutationResponse>(`/api/settings/sofia/knowledge/${id}`, input)
  return response.data.knowledgeItem
}

export async function deleteSofiaKnowledgeItem(id: string): Promise<void> {
  await apiService.delete(`/api/settings/sofia/knowledge/${id}`)
}
