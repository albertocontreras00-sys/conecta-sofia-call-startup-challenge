import { sql } from '../db/neon.js';

export interface SofiaKnowledgeItemRow {
  id: string;
  org_id: string;
  title: string;
  instructions: string;
  enabled: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateSofiaKnowledgeItemInput {
  orgId: string;
  title: string;
  instructions: string;
  enabled: boolean;
  userId: string | null;
}

export interface UpdateSofiaKnowledgeItemInput {
  orgId: string;
  id: string;
  title: string | null;
  instructions: string | null;
  enabled: boolean | null;
  hasTitle: boolean;
  hasInstructions: boolean;
  hasEnabled: boolean;
  userId: string | null;
}

export async function listSofiaKnowledgeItems(orgId: string): Promise<SofiaKnowledgeItemRow[]> {
  return await sql<SofiaKnowledgeItemRow>`
    SELECT
      id,
      org_id,
      title,
      instructions,
      enabled,
      created_by,
      updated_by,
      created_at,
      updated_at,
      deleted_at
    FROM sofia_knowledge_items
    WHERE org_id = ${orgId}::uuid
      AND deleted_at IS NULL
    ORDER BY enabled DESC, updated_at DESC, created_at DESC
  `;
}

export async function listEnabledSofiaKnowledgeItems(orgId: string): Promise<SofiaKnowledgeItemRow[]> {
  return await sql<SofiaKnowledgeItemRow>`
    SELECT
      id,
      org_id,
      title,
      instructions,
      enabled,
      created_by,
      updated_by,
      created_at,
      updated_at,
      deleted_at
    FROM sofia_knowledge_items
    WHERE org_id = ${orgId}::uuid
      AND enabled = true
      AND deleted_at IS NULL
    ORDER BY updated_at DESC, created_at DESC
  `;
}

export async function createSofiaKnowledgeItem(input: CreateSofiaKnowledgeItemInput): Promise<SofiaKnowledgeItemRow> {
  const rows = await sql<SofiaKnowledgeItemRow>`
    INSERT INTO sofia_knowledge_items (
      org_id,
      title,
      instructions,
      enabled,
      created_by,
      updated_by
    ) VALUES (
      ${input.orgId}::uuid,
      ${input.title},
      ${input.instructions},
      ${input.enabled},
      ${input.userId}::uuid,
      ${input.userId}::uuid
    )
    RETURNING
      id,
      org_id,
      title,
      instructions,
      enabled,
      created_by,
      updated_by,
      created_at,
      updated_at,
      deleted_at
  `;
  const row = rows[0];
  if (!row) throw new Error('SOFIA_KNOWLEDGE_ITEM_NOT_CREATED');
  return row;
}

export async function updateSofiaKnowledgeItem(input: UpdateSofiaKnowledgeItemInput): Promise<SofiaKnowledgeItemRow | null> {
  const rows = await sql<SofiaKnowledgeItemRow>`
    UPDATE sofia_knowledge_items
    SET
      title = CASE WHEN ${input.hasTitle} THEN ${input.title} ELSE title END,
      instructions = CASE WHEN ${input.hasInstructions} THEN ${input.instructions} ELSE instructions END,
      enabled = CASE WHEN ${input.hasEnabled} THEN ${input.enabled} ELSE enabled END,
      updated_by = ${input.userId}::uuid,
      updated_at = now()
    WHERE org_id = ${input.orgId}::uuid
      AND id = ${input.id}::uuid
      AND deleted_at IS NULL
    RETURNING
      id,
      org_id,
      title,
      instructions,
      enabled,
      created_by,
      updated_by,
      created_at,
      updated_at,
      deleted_at
  `;
  return rows[0] || null;
}

export async function softDeleteSofiaKnowledgeItem(input: {
  orgId: string;
  id: string;
  userId: string | null;
}): Promise<SofiaKnowledgeItemRow | null> {
  const rows = await sql<SofiaKnowledgeItemRow>`
    UPDATE sofia_knowledge_items
    SET
      enabled = false,
      updated_by = ${input.userId}::uuid,
      updated_at = now(),
      deleted_at = now()
    WHERE org_id = ${input.orgId}::uuid
      AND id = ${input.id}::uuid
      AND deleted_at IS NULL
    RETURNING
      id,
      org_id,
      title,
      instructions,
      enabled,
      created_by,
      updated_by,
      created_at,
      updated_at,
      deleted_at
  `;
  return rows[0] || null;
}
