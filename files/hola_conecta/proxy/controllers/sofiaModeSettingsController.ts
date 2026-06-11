import type { Response } from 'express'
import { getModeSettings, updateModeSettings, getDefaultFlags } from '../models/sofiaModeSettingsModel.js'
import * as response from '../utils/response.js'
import { logError, logInfo } from '../utils/logger.js'
import { isValidUUID } from '../utils/validation.js'
import type { JsonValue } from '../types/json.ts'
import type {
  SofiaFlagDefinitions,
  SofiaFlags,
  SofiaRequest} from '../types/sofia.js'

interface UpdateSettingsBody {
  flags?: Partial<SofiaFlags>
}

function normalizeOrgId(value: JsonValue | undefined): string | null {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') {
    return null
  }
  return isValidUUID(trimmed) ? trimmed : null
}

function resolveOrgId(req: SofiaRequest): string | null {
  const rawHeader = req.headers?.['x-org-id']
  const headerOrgId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader

  return (
    normalizeOrgId(headerOrgId) ||
    normalizeOrgId(req.orgContext?.orgId) ||
    normalizeOrgId(req.orgContext?.org_id) ||
    normalizeOrgId(req.orgId) ||
    normalizeOrgId(req.userData?.org_id) ||
    normalizeOrgId(req.adminUser?.primary_org_id) ||
    null
  )
}

export async function getSettings(req: SofiaRequest, res: Response): Promise<Response | void> {
  try {
    const orgId = resolveOrgId(req)

    if (!orgId) {
      return response.badRequest(res, 'Organization ID required')
    }

    const settings = await getModeSettings(orgId)

    return response.success(res, {
      data: {
        flags: settings.flags,
        updated_at: settings.updated_at,
        updated_by_email: settings.updated_by_email,
        available_flags: Object.keys(getDefaultFlags())}})
  } catch (error) {
    logError('SofiaModeSettingsController', 'Failed to get settings', error)
    return response.internalError(res, error)
  }
}

export async function updateSettings(
  req: SofiaRequest<UpdateSettingsBody>,
  res: Response,
): Promise<Response | void> {
  try {
    const orgId = resolveOrgId(req)
    const flags = req.body?.flags

    if (!orgId) {
      return response.badRequest(res, 'Organization ID required')
    }

    if (!flags || typeof flags !== 'object') {
      return response.badRequest(res, 'flags object required in request body')
    }

    const updatedByUid = req.user?.uid ?? null
    const updatedByEmail = req.user?.email ?? req.orgContext?.email ?? null

    const updated = await updateModeSettings(orgId, flags, updatedByUid, updatedByEmail)

    logInfo('SofiaModeSettingsController', 'Settings updated via API', {
      orgId,
      updatedByEmail,
      flagsChanged: Object.keys(flags)})

    return response.success(res, {
      data: {
        flags: updated.flags,
        updated_at: updated.updated_at,
        updated_by_email: updated.updated_by_email},
      message: 'Sofia mode settings updated'})
  } catch (error) {
    logError('SofiaModeSettingsController', 'Failed to update settings', error)
    return response.internalError(res, error)
  }
}

export async function getDefaults(_req: SofiaRequest, res: Response): Promise<Response | void> {
  try {
    const defaults = getDefaultFlags()

    const flagDefinitions: SofiaFlagDefinitions = {
      debug: {
        label: 'Debug Mode',
        description: 'Enable technical debugging responses and tool testing behavior',
        default: defaults.debug},
      facebook_live: {
        label: 'Facebook Live Mode',
        description: 'Optimize for live streaming - engaging, confident, audience-aware',
        default: defaults.facebook_live},
      demo: {
        label: 'Demo Mode',
        description: 'Demo presentation mode - showcase features enthusiastically',
        default: defaults.demo},
      verbose_logs: {
        label: 'Verbose Logging',
        description: 'Enable detailed logging for debugging purposes',
        default: defaults.verbose_logs},
      allow_write_tools: {
        label: 'Allow Write Tools',
        description: 'Enable tools that can create/send (tasks, SMS, email)',
        default: defaults.allow_write_tools},
      founder_mode: {
        label: 'Founder Mode',
        description: 'Co-founder persona - candid, strategic, teammate tone',
        default: defaults.founder_mode}}

    return response.success(res, { data: flagDefinitions })
  } catch (error) {
    logError('SofiaModeSettingsController', 'Failed to get defaults', error)
    return response.internalError(res, error)
  }
}

export default {
  getSettings,
  updateSettings,
  getDefaults}
