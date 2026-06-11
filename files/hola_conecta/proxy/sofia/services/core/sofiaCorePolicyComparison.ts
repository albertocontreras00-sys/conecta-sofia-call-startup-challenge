import type { SofiaCoreJsonObject, SofiaCoreJsonValue } from './types.ts';

export type SofiaPolicyComparisonEventType =
  | 'sofia_context_envelope_built'
  | 'sofia_core_policy_dry_run'
  | 'sofia_tool_boundary_policy_dry_run'
  | 'sofia_action_lifecycle_policy_dry_run'
  | 'unknown';

export type SofiaPolicyMismatchType =
  | 'core_tool_action_mismatch'
  | 'core_tool_decision_mismatch'
  | 'tool_sensitive_action_without_core_intent'
  | 'voice_sensitive_action_channel_trust'
  | 'website_sensitive_action_attempt'
  | 'lifecycle_executed_without_prior_allowed_or_approved_signal';

export interface SofiaPolicyComparisonEvent extends SofiaCoreJsonObject {
  event?: string;
  reason?: string;
  correlationKey?: string;
  policyCorrelation?: SofiaCoreJsonObject | null;
  policyDryRun?: SofiaCoreJsonObject | null;
}

export interface SofiaPolicyCorrelationGroup {
  correlationKey: string;
  events: SofiaPolicyComparisonEvent[];
  missingCorrelationKey: boolean;
}

export interface SofiaPolicyMismatch extends SofiaCoreJsonObject {
  type: SofiaPolicyMismatchType;
  correlationKey: string;
  action: string | null;
  coreAction: string | null;
  toolAction: string | null;
  channel: string | null;
  trustLevel: string | null;
  allowed: boolean | null;
  requiresVerification: boolean | null;
  requiresApproval: boolean | null;
}

export interface SofiaPolicyCorrelationGroupSummary extends SofiaCoreJsonObject {
  correlationKey: string;
  eventCount: number;
  hasCore: boolean;
  hasToolBoundary: boolean;
  hasLifecycle: boolean;
  missingCorrelationKey: boolean;
  actions: string[];
  coreActions: string[];
  toolActions: string[];
  lifecycleActions: string[];
  allowedCount: number;
  requiresVerificationCount: number;
  requiresApprovalCount: number;
  blockedCount: number;
  missingSessionIdCount: number;
  missingTurnIdCount: number;
  missingCallIdCount: number;
  missingRequestIdCount: number;
  websiteSensitiveActionAttempts: number;
  websiteHandoffDisabledConfirmed: boolean;
  mismatches: SofiaPolicyMismatch[];
}

export interface SofiaPolicyComparisonReport extends SofiaCoreJsonObject {
  totalEvents: number;
  totalCorrelationGroups: number;
  groupsWithCoreIntentOnly: number;
  groupsWithToolBoundaryOnly: number;
  groupsWithBothCoreAndToolBoundary: number;
  groupsMissingCorrelationKey: number;
  actionsAttempted: Record<string, number>;
  actionsAllowedByDryRun: Record<string, number>;
  actionsRequiringVerification: Record<string, number>;
  actionsRequiringApproval: Record<string, number>;
  actionsBlocked: Record<string, number>;
  missingSessionIdRate: number;
  missingTurnIdRate: number;
  missingCallIdRate: number;
  missingRequestIdRate: number;
  websiteActionAttempts: number;
  websiteHandoffDisabledConfirmations: number;
  mismatches: SofiaPolicyMismatch[];
  groups: SofiaPolicyCorrelationGroupSummary[];
}

function isObject(value: unknown): value is SofiaCoreJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: SofiaCoreJsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanValue(value: SofiaCoreJsonValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function nestedObject(event: SofiaPolicyComparisonEvent, key: string): SofiaCoreJsonObject {
  const value = event[key];
  return isObject(value) ? value : {};
}

function eventType(event: SofiaPolicyComparisonEvent): SofiaPolicyComparisonEventType {
  const eventName = stringValue(event.event);
  const reason = stringValue(event.reason);
  if (eventName === 'sofia_context_envelope_built' || reason === 'sofia_action_intent_observed') return 'sofia_context_envelope_built';
  if (eventName === 'sofia_core_policy_dry_run') return 'sofia_core_policy_dry_run';
  if (eventName === 'sofia_action_lifecycle_policy_dry_run') return 'sofia_action_lifecycle_policy_dry_run';
  if (eventName === 'sofia_tool_boundary_policy_dry_run') {
    const correlation = nestedObject(event, 'policyCorrelation');
    return stringValue(correlation.lifecycleAction) ? 'sofia_action_lifecycle_policy_dry_run' : 'sofia_tool_boundary_policy_dry_run';
  }
  return 'unknown';
}

function correlation(event: SofiaPolicyComparisonEvent): SofiaCoreJsonObject {
  return nestedObject(event, 'policyCorrelation');
}

function decision(event: SofiaPolicyComparisonEvent): SofiaCoreJsonObject {
  const dryRun = nestedObject(event, 'policyDryRun');
  return Object.keys(dryRun).length ? dryRun : event;
}

function correlationKey(event: SofiaPolicyComparisonEvent, index: number): { key: string; missing: boolean } {
  const nested = correlation(event);
  const key = stringValue(nested.correlationKey) || stringValue(event.correlationKey);
  return key ? { key, missing: false } : { key: `missing-correlation-key:${index}`, missing: true };
}

function actionOf(event: SofiaPolicyComparisonEvent): string | null {
  const nested = correlation(event);
  const eventDecision = decision(event);
  return (
    stringValue(nested.action) ||
    stringValue(eventDecision.action) ||
    stringValue(event.policyAction) ||
    null
  );
}

function _routeActionOf(event: SofiaPolicyComparisonEvent): string | null {
  const nested = correlation(event);
  return stringValue(nested.routeAction) || stringValue(event.routeName);
}

function lifecycleActionOf(event: SofiaPolicyComparisonEvent): string | null {
  const nested = correlation(event);
  return stringValue(nested.lifecycleAction);
}

function channelOf(event: SofiaPolicyComparisonEvent): string | null {
  const nested = correlation(event);
  return stringValue(nested.channel) || stringValue(event.channel);
}

function trustLevelOf(event: SofiaPolicyComparisonEvent): string | null {
  return stringValue(event.trustLevel);
}

function allowedOf(event: SofiaPolicyComparisonEvent): boolean | null {
  const nested = correlation(event);
  const eventDecision = decision(event);
  return booleanValue(nested.allowed) ?? booleanValue(eventDecision.allowed);
}

function requiresVerificationOf(event: SofiaPolicyComparisonEvent): boolean | null {
  const nested = correlation(event);
  const eventDecision = decision(event);
  return booleanValue(nested.requiresVerification) ?? booleanValue(eventDecision.requiresVerification);
}

function requiresApprovalOf(event: SofiaPolicyComparisonEvent): boolean | null {
  const nested = correlation(event);
  const eventDecision = decision(event);
  return booleanValue(nested.requiresApproval) ?? booleanValue(eventDecision.requiresApproval);
}

function hasId(event: SofiaPolicyComparisonEvent, key: 'sessionId' | 'turnId' | 'callId' | 'requestId'): boolean {
  const nested = correlation(event);
  return Boolean(stringValue(nested[key]) || stringValue(event[key]));
}

function unique(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function increment(map: Record<string, number>, key: string | null): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function isSensitiveAction(action: string | null): boolean {
  return action === 'send_sms' ||
    action === 'send_email' ||
    action === 'send_whatsapp' ||
    action === 'cancel_booking' ||
    action === 'reschedule_booking' ||
    action === 'create_booking';
}

function isWebsiteSensitiveAction(event: SofiaPolicyComparisonEvent): boolean {
  const action = actionOf(event);
  return channelOf(event) === 'website_chat' && (action === 'send_sms' || action === 'send_email' || action === 'send_whatsapp');
}

export function groupSofiaPolicyEventsByCorrelationKey(
  events: SofiaPolicyComparisonEvent[]
): SofiaPolicyCorrelationGroup[] {
  const groups = new Map<string, SofiaPolicyCorrelationGroup>();

  events.forEach((event, index) => {
    const { key, missing } = correlationKey(event, index);
    const existing = groups.get(key);
    if (existing) {
      existing.events.push(event);
      existing.missingCorrelationKey = existing.missingCorrelationKey || missing;
      return;
    }
    groups.set(key, {
      correlationKey: key,
      events: [event],
      missingCorrelationKey: missing
    });
  });

  return Array.from(groups.values());
}

export function findSofiaPolicyMismatches(group: SofiaPolicyCorrelationGroup): SofiaPolicyMismatch[] {
  const coreEvents = group.events.filter((event) => eventType(event) === 'sofia_context_envelope_built' || eventType(event) === 'sofia_core_policy_dry_run');
  const toolEvents = group.events.filter((event) => eventType(event) === 'sofia_tool_boundary_policy_dry_run');
  const lifecycleEvents = group.events.filter((event) => eventType(event) === 'sofia_action_lifecycle_policy_dry_run');
  const mismatches: SofiaPolicyMismatch[] = [];
  const coreActions = unique(coreEvents.map(actionOf));
  const toolActions = unique(toolEvents.map(actionOf));

  for (const coreAction of coreActions) {
    for (const toolAction of toolActions) {
      if (coreAction !== toolAction) {
        mismatches.push(buildMismatch('core_tool_action_mismatch', group, coreAction, toolAction, toolEvents[0] ?? coreEvents[0]));
      }
    }
  }

  for (const toolEvent of toolEvents) {
    const action = actionOf(toolEvent);
    if (isSensitiveAction(action) && !coreActions.length) {
      mismatches.push(buildMismatch('tool_sensitive_action_without_core_intent', group, null, action, toolEvent));
    }
    if (channelOf(toolEvent) === 'voice' && trustLevelOf(toolEvent) === 'channel' && isSensitiveAction(action)) {
      mismatches.push(buildMismatch('voice_sensitive_action_channel_trust', group, null, action, toolEvent));
    }
    if (isWebsiteSensitiveAction(toolEvent)) {
      mismatches.push(buildMismatch('website_sensitive_action_attempt', group, null, action, toolEvent));
    }
  }

  for (const coreEvent of coreEvents) {
    for (const toolEvent of toolEvents) {
      const coreAllowed = allowedOf(coreEvent);
      const toolAllowed = allowedOf(toolEvent);
      if (typeof coreAllowed === 'boolean' && typeof toolAllowed === 'boolean' && coreAllowed !== toolAllowed) {
        mismatches.push(buildMismatch('core_tool_decision_mismatch', group, actionOf(coreEvent), actionOf(toolEvent), toolEvent));
      }
    }
  }

  const hasPriorAllowedOrApproved = [...coreEvents, ...toolEvents].some((event) => allowedOf(event) === true || requiresApprovalOf(event) === true);
  for (const lifecycleEvent of lifecycleEvents) {
    const lifecycleAction = lifecycleActionOf(lifecycleEvent) || actionOf(lifecycleEvent);
    if (lifecycleAction && !hasPriorAllowedOrApproved) {
      mismatches.push(buildMismatch('lifecycle_executed_without_prior_allowed_or_approved_signal', group, null, lifecycleAction, lifecycleEvent));
    }
  }

  return mismatches;
}

function buildMismatch(
  type: SofiaPolicyMismatchType,
  group: SofiaPolicyCorrelationGroup,
  coreAction: string | null,
  toolAction: string | null,
  event: SofiaPolicyComparisonEvent | undefined
): SofiaPolicyMismatch {
  return {
    type,
    correlationKey: group.correlationKey,
    action: toolAction || coreAction,
    coreAction,
    toolAction,
    channel: event ? channelOf(event) : null,
    trustLevel: event ? trustLevelOf(event) : null,
    allowed: event ? allowedOf(event) : null,
    requiresVerification: event ? requiresVerificationOf(event) : null,
    requiresApproval: event ? requiresApprovalOf(event) : null
  };
}

export function summarizeSofiaPolicyCorrelationGroup(
  group: SofiaPolicyCorrelationGroup
): SofiaPolicyCorrelationGroupSummary {
  const types = group.events.map(eventType);
  const mismatches = findSofiaPolicyMismatches(group);
  const actions = unique(group.events.map(actionOf));
  const allowedCount = group.events.filter((event) => allowedOf(event) === true).length;
  const requiresVerificationCount = group.events.filter((event) => requiresVerificationOf(event) === true).length;
  const requiresApprovalCount = group.events.filter((event) => requiresApprovalOf(event) === true).length;

  return {
    correlationKey: group.correlationKey,
    eventCount: group.events.length,
    hasCore: types.includes('sofia_context_envelope_built') || types.includes('sofia_core_policy_dry_run'),
    hasToolBoundary: types.includes('sofia_tool_boundary_policy_dry_run'),
    hasLifecycle: types.includes('sofia_action_lifecycle_policy_dry_run'),
    missingCorrelationKey: group.missingCorrelationKey,
    actions,
    coreActions: unique(group.events.filter((event) => eventType(event) === 'sofia_context_envelope_built' || eventType(event) === 'sofia_core_policy_dry_run').map(actionOf)),
    toolActions: unique(group.events.filter((event) => eventType(event) === 'sofia_tool_boundary_policy_dry_run').map(actionOf)),
    lifecycleActions: unique(group.events.filter((event) => eventType(event) === 'sofia_action_lifecycle_policy_dry_run').map((event) => lifecycleActionOf(event) || actionOf(event))),
    allowedCount,
    requiresVerificationCount,
    requiresApprovalCount,
    blockedCount: group.events.filter((event) => allowedOf(event) === false && requiresVerificationOf(event) !== true && requiresApprovalOf(event) !== true).length,
    missingSessionIdCount: group.events.filter((event) => !hasId(event, 'sessionId')).length,
    missingTurnIdCount: group.events.filter((event) => !hasId(event, 'turnId')).length,
    missingCallIdCount: group.events.filter((event) => !hasId(event, 'callId')).length,
    missingRequestIdCount: group.events.filter((event) => !hasId(event, 'requestId')).length,
    websiteSensitiveActionAttempts: group.events.filter(isWebsiteSensitiveAction).length,
    websiteHandoffDisabledConfirmed: group.events.some((event) => channelOf(event) === 'website_chat' && actionOf(event) !== 'handoff'),
    mismatches
  };
}

export function compareSofiaPolicyEvents(events: SofiaPolicyComparisonEvent[]): SofiaPolicyCorrelationGroupSummary[] {
  return groupSofiaPolicyEventsByCorrelationKey(events).map(summarizeSofiaPolicyCorrelationGroup);
}

export function buildSofiaPolicyComparisonReport(events: SofiaPolicyComparisonEvent[]): SofiaPolicyComparisonReport {
  const groups = groupSofiaPolicyEventsByCorrelationKey(events);
  const summaries = groups.map(summarizeSofiaPolicyCorrelationGroup);
  const actionsAttempted: Record<string, number> = {};
  const actionsAllowedByDryRun: Record<string, number> = {};
  const actionsRequiringVerification: Record<string, number> = {};
  const actionsRequiringApproval: Record<string, number> = {};
  const actionsBlocked: Record<string, number> = {};
  let missingSessionId = 0;
  let missingTurnId = 0;
  let missingCallId = 0;
  let missingRequestId = 0;

  for (const event of events) {
    const action = actionOf(event);
    increment(actionsAttempted, action);
    if (allowedOf(event) === true) increment(actionsAllowedByDryRun, action);
    if (requiresVerificationOf(event) === true) increment(actionsRequiringVerification, action);
    if (requiresApprovalOf(event) === true) increment(actionsRequiringApproval, action);
    if (allowedOf(event) === false && requiresVerificationOf(event) !== true && requiresApprovalOf(event) !== true) increment(actionsBlocked, action);
    if (!hasId(event, 'sessionId')) missingSessionId += 1;
    if (!hasId(event, 'turnId')) missingTurnId += 1;
    if (!hasId(event, 'callId')) missingCallId += 1;
    if (!hasId(event, 'requestId')) missingRequestId += 1;
  }

  return {
    totalEvents: events.length,
    totalCorrelationGroups: groups.length,
    groupsWithCoreIntentOnly: summaries.filter((group) => group.hasCore && !group.hasToolBoundary).length,
    groupsWithToolBoundaryOnly: summaries.filter((group) => group.hasToolBoundary && !group.hasCore).length,
    groupsWithBothCoreAndToolBoundary: summaries.filter((group) => group.hasCore && group.hasToolBoundary).length,
    groupsMissingCorrelationKey: summaries.filter((group) => group.missingCorrelationKey).length,
    actionsAttempted,
    actionsAllowedByDryRun,
    actionsRequiringVerification,
    actionsRequiringApproval,
    actionsBlocked,
    missingSessionIdRate: rate(missingSessionId, events.length),
    missingTurnIdRate: rate(missingTurnId, events.length),
    missingCallIdRate: rate(missingCallId, events.length),
    missingRequestIdRate: rate(missingRequestId, events.length),
    websiteActionAttempts: events.filter(isWebsiteSensitiveAction).length,
    websiteHandoffDisabledConfirmations: summaries.filter((group) => group.websiteHandoffDisabledConfirmed).length,
    mismatches: summaries.flatMap((group) => group.mismatches),
    groups: summaries
  };
}

function rate(count: number, total: number): number {
  if (!total) return 0;
  return Number((count / total).toFixed(4));
}

export function sanitizeSofiaPolicyComparisonReport(report: SofiaPolicyComparisonReport): SofiaPolicyComparisonReport {
  return {
    totalEvents: report.totalEvents,
    totalCorrelationGroups: report.totalCorrelationGroups,
    groupsWithCoreIntentOnly: report.groupsWithCoreIntentOnly,
    groupsWithToolBoundaryOnly: report.groupsWithToolBoundaryOnly,
    groupsWithBothCoreAndToolBoundary: report.groupsWithBothCoreAndToolBoundary,
    groupsMissingCorrelationKey: report.groupsMissingCorrelationKey,
    actionsAttempted: { ...report.actionsAttempted },
    actionsAllowedByDryRun: { ...report.actionsAllowedByDryRun },
    actionsRequiringVerification: { ...report.actionsRequiringVerification },
    actionsRequiringApproval: { ...report.actionsRequiringApproval },
    actionsBlocked: { ...report.actionsBlocked },
    missingSessionIdRate: report.missingSessionIdRate,
    missingTurnIdRate: report.missingTurnIdRate,
    missingCallIdRate: report.missingCallIdRate,
    missingRequestIdRate: report.missingRequestIdRate,
    websiteActionAttempts: report.websiteActionAttempts,
    websiteHandoffDisabledConfirmations: report.websiteHandoffDisabledConfirmations,
    mismatches: report.mismatches.map((mismatch) => ({ ...mismatch })),
    groups: report.groups.map((group) => ({
      ...group,
      actions: [...group.actions],
      coreActions: [...group.coreActions],
      toolActions: [...group.toolActions],
      lifecycleActions: [...group.lifecycleActions],
      mismatches: group.mismatches.map((mismatch) => ({ ...mismatch }))
    }))
  };
}
