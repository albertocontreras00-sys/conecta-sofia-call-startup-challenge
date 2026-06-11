import type { Response } from 'express';
import { isAdminOrOwner } from '../../services/access/index.ts';
import {
  createSofiaKnowledgeForSettings,
  deleteSofiaKnowledgeForSettings,
  listSofiaKnowledgeForSettings,
  SofiaSettingsValidationError,
  updateSofiaKnowledgeForSettings,
} from '../../services/settings/sofiaSettingsService.ts';
import { error, success } from '../../utils/response.js';
import { logError } from '../../utils/logger.js';
import { isValidUUID } from '../../utils/validation.js';
import {
  getErrorMessage,
  getOrgAccessOrDeny,
  type EmptyParams,
  type SettingsRequest,
} from './shared.ts';

interface SofiaKnowledgeBody {
  title?: unknown;
  instructions?: unknown;
  enabled?: unknown;
}

function handleSofiaSettingsError(res: Response, err: unknown) {
  if (err instanceof SofiaSettingsValidationError) {
    return error(res, err.code, err.message, err.status);
  }

  const message = getErrorMessage(err);
  if (message.includes('SOFIA_KNOWLEDGE')) {
    return error(res, 'BAD_REQUEST', message, 400);
  }

  logError('settings.sofia', 'Sofia settings request failed', err);
  return error(res, 'INTERNAL_ERROR', 'Failed to save Sofia settings', 500);
}

async function requireSofiaSettingsAccess<
  Params extends Record<string, string | string[] | undefined>,
  Body,
  Query extends Record<string, string | string[] | undefined>,
>(
  req: SettingsRequest<Params, Body, Query>,
  res: Response,
  options: { requireManage?: boolean } = {},
) {
  const access = await getOrgAccessOrDeny(req, res);
  if (!access) return null;

  if (options.requireManage && !isAdminOrOwner(access.accessContext)) {
    error(res, 'FORBIDDEN', 'Only admins can manage Sofia settings', 403);
    return null;
  }

  return access;
}

async function listSofiaKnowledge(
  req: SettingsRequest<EmptyParams>,
  res: Response,
) {
  try {
    const access = await requireSofiaSettingsAccess(req, res);
    if (!access) return;

    const knowledgeItems = await listSofiaKnowledgeForSettings(access.orgId);
    return success(res, { data: { knowledgeItems } });
  } catch (err) {
    return handleSofiaSettingsError(res, err);
  }
}

async function createSofiaKnowledge(
  req: SettingsRequest<EmptyParams, SofiaKnowledgeBody>,
  res: Response,
) {
  try {
    const access = await requireSofiaSettingsAccess(req, res, { requireManage: true });
    if (!access) return;

    const knowledgeItem = await createSofiaKnowledgeForSettings({
      orgId: access.orgId,
      userId: access.userId,
      title: req.body?.title,
      instructions: req.body?.instructions,
      enabled: req.body?.enabled,
    });

    return success(res, { data: { knowledgeItem } }, 201);
  } catch (err) {
    return handleSofiaSettingsError(res, err);
  }
}

async function updateSofiaKnowledge(
  req: SettingsRequest<{ id?: string }, SofiaKnowledgeBody>,
  res: Response,
) {
  try {
    const access = await requireSofiaSettingsAccess(req, res, { requireManage: true });
    if (!access) return;

    const id = req.params?.id;
    if (!id || !isValidUUID(id)) {
      return error(res, 'BAD_REQUEST', 'Knowledge item id is invalid', 400);
    }

    const knowledgeItem = await updateSofiaKnowledgeForSettings({
      orgId: access.orgId,
      id,
      userId: access.userId,
      title: req.body?.title,
      instructions: req.body?.instructions,
      enabled: req.body?.enabled,
    });

    if (!knowledgeItem) {
      return error(res, 'NOT_FOUND', 'Knowledge item not found', 404);
    }

    return success(res, { data: { knowledgeItem } });
  } catch (err) {
    return handleSofiaSettingsError(res, err);
  }
}

async function deleteSofiaKnowledge(
  req: SettingsRequest<{ id?: string }>,
  res: Response,
) {
  try {
    const access = await requireSofiaSettingsAccess(req, res, { requireManage: true });
    if (!access) return;

    const id = req.params?.id;
    if (!id || !isValidUUID(id)) {
      return error(res, 'BAD_REQUEST', 'Knowledge item id is invalid', 400);
    }

    const knowledgeItem = await deleteSofiaKnowledgeForSettings({
      orgId: access.orgId,
      id,
      userId: access.userId,
    });

    if (!knowledgeItem) {
      return error(res, 'NOT_FOUND', 'Knowledge item not found', 404);
    }

    return success(res, { data: { deleted: true, knowledgeItem } });
  } catch (err) {
    return handleSofiaSettingsError(res, err);
  }
}

export default {
  listSofiaKnowledge,
  createSofiaKnowledge,
  updateSofiaKnowledge,
  deleteSofiaKnowledge,
};
