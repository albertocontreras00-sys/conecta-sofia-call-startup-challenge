import {
  createSofiaKnowledgeItem,
  listEnabledSofiaKnowledgeItems,
  listSofiaKnowledgeItems,
  softDeleteSofiaKnowledgeItem,
  updateSofiaKnowledgeItem,
  type SofiaKnowledgeItemRow,
} from '../../models/sofiaKnowledgeItemsModel.ts';

const KNOWLEDGE_TITLE_MAX_LENGTH = 120;
const KNOWLEDGE_INSTRUCTIONS_MAX_LENGTH = 2000;

export class SofiaSettingsValidationError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'SofiaSettingsValidationError';
    this.code = code;
    this.status = status;
  }
}

export interface SofiaKnowledgeItemDto {
  id: string;
  title: string;
  instructions: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

function normalizeString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new SofiaSettingsValidationError('INVALID_FIELD', `${fieldName} is required`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new SofiaSettingsValidationError('INVALID_FIELD', `${fieldName} is required`);
  }

  if (trimmed.length > maxLength) {
    throw new SofiaSettingsValidationError(
      'INVALID_FIELD',
      `${fieldName} must be ${maxLength} characters or fewer`,
    );
  }

  return trimmed;
}

function normalizeOptionalString(value: unknown, fieldName: string, maxLength: number): string | null {
  if (value === undefined) return null;
  return normalizeString(value, fieldName, maxLength);
}

function normalizeEnabled(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new SofiaSettingsValidationError('INVALID_FIELD', 'enabled must be true or false');
  }
  return value;
}

function toKnowledgeItemDto(row: SofiaKnowledgeItemRow): SofiaKnowledgeItemDto {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    enabled: row.enabled === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

export function formatSofiaKnowledgeForVoiceContext(items: SofiaKnowledgeItemRow[]): string {
  const lines = items
    .filter(item => item.enabled === true && !item.deleted_at)
    .map(item => {
      const title = item.title.trim().replace(/\s+/g, ' ');
      const instructions = item.instructions.trim().replace(/\s+/g, ' ');
      return title && instructions ? `- ${title}: ${instructions}` : '';
    })
    .filter(Boolean);

  if (lines.length === 0) return '';
  return ['Current business updates Sofia should know:', ...lines].join('\n');
}

export async function loadSofiaBusinessKnowledgeVoiceContext(orgId: string): Promise<string> {
  const items = await listEnabledSofiaKnowledgeItems(orgId);
  return formatSofiaKnowledgeForVoiceContext(items);
}

export async function listSofiaKnowledgeForSettings(orgId: string): Promise<SofiaKnowledgeItemDto[]> {
  const items = await listSofiaKnowledgeItems(orgId);
  return items.map(toKnowledgeItemDto);
}

export async function createSofiaKnowledgeForSettings(input: {
  orgId: string;
  userId: string | null;
  title: unknown;
  instructions: unknown;
  enabled: unknown;
}): Promise<SofiaKnowledgeItemDto> {
  const title = normalizeString(input.title, 'Title', KNOWLEDGE_TITLE_MAX_LENGTH);
  const instructions = normalizeString(input.instructions, 'What should Sofia know?', KNOWLEDGE_INSTRUCTIONS_MAX_LENGTH);
  const enabled = normalizeEnabled(input.enabled, true);

  const item = await createSofiaKnowledgeItem({
    orgId: input.orgId,
    userId: input.userId,
    title,
    instructions,
    enabled,
  });
  return toKnowledgeItemDto(item);
}

export async function updateSofiaKnowledgeForSettings(input: {
  orgId: string;
  id: string;
  userId: string | null;
  title: unknown;
  instructions: unknown;
  enabled: unknown;
}): Promise<SofiaKnowledgeItemDto | null> {
  const hasTitle = input.title !== undefined;
  const hasInstructions = input.instructions !== undefined;
  const hasEnabled = input.enabled !== undefined;

  const item = await updateSofiaKnowledgeItem({
    orgId: input.orgId,
    id: input.id,
    userId: input.userId,
    hasTitle,
    hasInstructions,
    hasEnabled,
    title: hasTitle ? normalizeOptionalString(input.title, 'Title', KNOWLEDGE_TITLE_MAX_LENGTH) : null,
    instructions: hasInstructions
      ? normalizeOptionalString(input.instructions, 'What should Sofia know?', KNOWLEDGE_INSTRUCTIONS_MAX_LENGTH)
      : null,
    enabled: hasEnabled ? normalizeEnabled(input.enabled, true) : null,
  });

  return item ? toKnowledgeItemDto(item) : null;
}

export async function deleteSofiaKnowledgeForSettings(input: {
  orgId: string;
  id: string;
  userId: string | null;
}): Promise<SofiaKnowledgeItemDto | null> {
  const deleted = await softDeleteSofiaKnowledgeItem(input);
  return deleted ? toKnowledgeItemDto(deleted) : null;
}
