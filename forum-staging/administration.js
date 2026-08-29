import { setTimeout as sleep } from 'node:timers/promises';
import { stripHtmlTags } from './authored-text.js';
import { normalizeDatabaseId } from './database-id.js';
import { forumRestartMinimumIntervalMs } from './forum-restart.js';
import {
  grantableModeratorPermissions,
  isAdministrator,
  permissions,
  requirePermission,
} from './policy.js';
import { parseIsoTimestamp } from './timestamp.js';
import { isCanonicalUuid } from './uuid.js';
import {
  createUsernameColorUnlockCode,
  digestUsernameColorUnlockCode,
} from './username-color-effects.js';
import {
  createRegistrationInviteSalt,
  createRegistrationInviteToken,
  deriveRegistrationInviteVerifier,
  digestRegistrationInviteToken,
} from './registration-invites.js';

const maximumPageSize = 50;
const managedMembershipStatuses = new Set([
  'active',
  'pending',
  'rejected',
  'revoked',
  'suspended',
]);
const managedRoles = new Set(['admin', 'member', 'moderator']);
const shoutboxVisibilityModes = new Set(['count', 'time']);
const usernameRenameDecisions = new Set(['approved', 'rejected']);
const maximumDiagnosticLagMs = 5000;
const maximumDiagnosticNotificationCount = 25;
const maximumDiagnosticShoutboxLoad = 50;
const maximumDiagnosticShoutboxWrites = 20;
const mutationAuditReasons = new Map([
  ['account.delete', 'Account deleted'],
  ['account.force_password_reset', 'Password reset required'],
  ['account.forum_posting_mute', 'Forum posting mute changed'],
  ['account.membership', 'Membership status changed'],
  ['account.moderator_grants', 'Moderator permissions changed'],
  ['account.owner_powers_removed', 'Owner powers removed by developer'],
  ['account.role', 'Account role changed'],
  ['account.shoutbox_posting_mute', 'Shoutbox posting mute changed'],
  ['account.slowdown', 'Posting slowdown changed'],
  ['account.update', 'Account settings changed'],
]);

export class AdministrationError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parsePageValue(value, fallback, maximum) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new AdministrationError('invalid_administration_query', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new AdministrationError('invalid_administration_query', 400);
  }
  return parsed;
}

function parsePageLimit(value, fallback) {
  const limit = parsePageValue(value, fallback, maximumPageSize);
  if (limit === 0) {
    throw new AdministrationError('invalid_administration_query', 400);
  }
  return limit;
}

function parseTargetId(value) {
  if (!isCanonicalUuid(value)) {
    throw new AdministrationError('invalid_account', 400);
  }
  return String(value);
}

function parseExpectedUpdatedAt(value, code = 'invalid_account_version') {
  const expectedUpdatedAt = parseIsoTimestamp(value);
  if (!expectedUpdatedAt) {
    throw new AdministrationError(code, 400);
  }
  return expectedUpdatedAt;
}

function parseRegistrationTokenInput(input, issuedAt) {
  const expectedKeys = ['confirmed', 'expiresAt', 'type'];
  const keys = input && !Array.isArray(input) ? Object.keys(input).sort() : [];
  const expiresAt = parseIsoTimestamp(input?.expiresAt);
  if (
    keys.join(',') !== expectedKeys.join(',')
    || input.confirmed !== true
    || input.type !== 'single-use'
    || !expiresAt
    || expiresAt.getTime() <= issuedAt.getTime()
  ) {
    throw new AdministrationError('invalid_registration_token', 400);
  }
  return {
    expiresAt,
    type: input.type,
  };
}

function parseRegistrationTokenRevocationInput(input) {
  const keys = input && !Array.isArray(input) ? Object.keys(input).sort() : [];
  if (keys.join(',') !== 'confirmed,expectedUpdatedAt' || input.confirmed !== true) {
    throw new AdministrationError('invalid_registration_token_revocation', 400);
  }
  return parseExpectedUpdatedAt(input.expectedUpdatedAt, 'invalid_site_settings_version');
}

function managedAccountProjection(account, includeEmail) {
  if (includeEmail) {
    return account;
  }
  const { email: _email, ...projection } = account;
  return projection;
}

export function createAdministrationService({
  authService,
  clock = () => new Date(),
  diagnosticDelay = (delayMs, signal) => sleep(delayMs, undefined, { signal }),
  diagnosticNow = () => performance.now(),
  forumRestart = null,
  forumRepository,
  inviteSaltFactory = createRegistrationInviteSalt,
  inviteTokenFactory = createRegistrationInviteToken,
  inviteVerifierFactory = deriveRegistrationInviteVerifier,
  repository,
  unlockCodeFactory = createUsernameColorUnlockCode,
}) {
  let diagnosticPending = false;
  let restartPending = false;

  async function listAccounts(sessionToken, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    requirePermission(account, permissions.usersView);
    const limit = parsePageLimit(query.limit, 25);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const [accounts, totalCount] = await Promise.all([
      repository.listManagedAccounts(account.id, limit + 1, offset),
      repository.countManagedAccounts(account.id),
    ]);
    return {
      accounts: accounts.slice(0, limit).map((managedAccount) => (
        managedAccountProjection(managedAccount, isAdministrator(account))
      )),
      hasMore: accounts.length > limit,
      nextOffset: offset + Math.min(accounts.length, limit),
      totalCount,
    };
  }

  async function listAudit(sessionToken, targetId, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    requirePermission(account, permissions.auditView);
    const limit = parsePageLimit(query.limit, 25);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const events = await repository.listAccountAudit(
      account.id,
      parseTargetId(targetId),
      limit + 1,
      offset,
    );
    return {
      events: events.slice(0, limit),
      hasMore: events.length > limit,
      nextOffset: offset + Math.min(events.length, limit),
    };
  }

  async function listAuthenticationAudit(sessionToken, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    requirePermission(account, permissions.auditView);
    const limit = parsePageLimit(query.limit, 25);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const events = await repository.listAuthenticationAudit(account.id, limit + 1, offset);
    return {
      events: events.slice(0, limit),
      hasMore: events.length > limit,
      nextOffset: offset + Math.min(events.length, limit),
    };
  }

  async function listDeletedAccountHistory(sessionToken, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    requirePermission(account, permissions.auditView);
    const limit = parsePageLimit(query.limit, 25);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const events = await repository.listDeletedAccountHistory(account.id, limit + 1, offset);
    return {
      events: events.slice(0, limit),
      hasMore: events.length > limit,
      nextOffset: offset + Math.min(events.length, limit),
    };
  }

  async function listUsernameRenameRequests(sessionToken, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    requirePermission(account, permissions.usersModerate);
    const limit = parsePageLimit(query.limit, 25);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const requests = await repository.listUsernameRenameRequests(
      account.id,
      limit + 1,
      offset,
    );
    return {
      hasMore: requests.length > limit,
      nextOffset: offset + Math.min(requests.length, limit),
      requests: requests.slice(0, limit),
    };
  }

  async function decideUsernameRenameRequest(
    sessionToken,
    csrfToken,
    requestId,
    input,
  ) {
    const keys = input && !Array.isArray(input) ? Object.keys(input).sort() : [];
    const id = normalizeDatabaseId(requestId);
    const reason = typeof input?.reason === 'string'
      ? stripHtmlTags(input.reason).trim()
      : '';
    const expectedUpdatedAt = parseIsoTimestamp(input?.expectedUpdatedAt);
    if (
      keys.join(',') !== 'decision,expectedUpdatedAt,reason'
      || !id
      || !usernameRenameDecisions.has(input?.decision)
      || !expectedUpdatedAt
      || reason.length < 3
      || reason.length > 500
    ) {
      throw new AdministrationError('invalid_username_rename_decision', 400);
    }
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.usersModerate);
    const result = await repository.decideUsernameRenameRequest({
      actorId: session.account.id,
      decidedAt: clock(),
      decision: input.decision,
      expectedUpdatedAt,
      reason,
      requestId: id,
    });
    if (result.status === 'not_found') {
      throw new AdministrationError('username_rename_request_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new AdministrationError('moderation_hierarchy_denied', 403);
    }
    if (result.status === 'permission_denied') {
      throw new AdministrationError('permission_denied', 403);
    }
    if (result.status === 'conflict') {
      throw new AdministrationError('username_rename_request_conflict', 409);
    }
    if (!usernameRenameDecisions.has(result.status) || !result.request) {
      throw new Error('invalid_username_rename_decision_result');
    }
    return result.request;
  }

  async function listContent(sessionToken, targetId, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    requirePermission(account, permissions.usersView);
    const id = parseTargetId(targetId);
    const limit = parsePageLimit(query.limit, 25);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (!await repository.findManagedAccount(account.id, id)) {
      throw new AdministrationError('account_not_found', 404);
    }
    const [posts, threads] = await Promise.all([
      forumRepository.listPostsByAccount(account.id, id, limit + 1, offset),
      forumRepository.listTopicsByAccount(account.id, id, Math.min(limit, 25)),
    ]);
    return {
      hasMore: posts.length > limit,
      nextOffset: offset + Math.min(posts.length, limit),
      posts: posts.slice(0, limit),
      threads,
    };
  }

  async function isPresenceCounterEnabled() {
    const settings = await repository.getSiteSettings();
    return settings.presenceCounterEnabled;
  }

  async function getSiteSettings(sessionToken) {
    const { account } = await authService.getSession(sessionToken);
    requirePermission(account, permissions.siteSettingsManage);
    return {
      ...await repository.getSiteSettings(),
      forumRestartAvailable: typeof forumRestart === 'function',
    };
  }

  async function getSiteAccessPolicy() {
    const settings = await repository.getSiteSettings();
    return {
      blocked: settings.accessBlocked,
      reason: settings.accessBlockReason,
    };
  }

  async function setSiteAccessBlock(sessionToken, csrfToken, input) {
    const blocked = input?.blocked;
    const expectedKeys = blocked
      ? ['blocked', 'expectedUpdatedAt', 'reason']
      : ['blocked', 'expectedUpdatedAt'];
    const keys = input && !Array.isArray(input) ? Object.keys(input).sort() : [];
    const reason = blocked && typeof input.reason === 'string'
      ? stripHtmlTags(input.reason).trim()
      : '';
    if (
      typeof blocked !== 'boolean'
      || keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || (blocked && (reason.length < 3 || reason.length > 500))
    ) {
      throw new AdministrationError('invalid_site_access_block', 400);
    }
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.siteSettingsManage);
    const settings = await repository.setSiteAccessBlock({
      actorId: session.account.id,
      blocked,
      expectedUpdatedAt: parseExpectedUpdatedAt(
        input.expectedUpdatedAt,
        'invalid_site_access_block_version',
      ),
      reason,
      updatedAt: clock(),
    });
    if (!settings) {
      throw new AdministrationError('site_settings_update_conflict', 409);
    }
    return settings;
  }

  async function setSiteSettings(sessionToken, csrfToken, input) {
    const countMode = input.shoutboxVisibilityMode === 'count';
    const timeMode = input.shoutboxVisibilityMode === 'time';
    const hasCount = Object.hasOwn(input, 'shoutboxVisibilityCount');
    const hasDays = Object.hasOwn(input, 'shoutboxVisibilityDays');
    const hasHours = Object.hasOwn(input, 'shoutboxVisibilityHours');
    if (
      Object.hasOwn(input, 'globalRegistrationTokenEnabled')
      || typeof input.presenceCounterEnabled !== 'boolean'
      || !shoutboxVisibilityModes.has(input.shoutboxVisibilityMode)
      || hasHours
      || (countMode && (
        !hasCount
        || hasDays
        || !Number.isInteger(input.shoutboxVisibilityCount)
        || input.shoutboxVisibilityCount < 10
        || input.shoutboxVisibilityCount > 200
      ))
      || (timeMode && (
        hasCount
        || !hasDays
        || !Number.isInteger(input.shoutboxVisibilityDays)
        || input.shoutboxVisibilityDays < 1
        || input.shoutboxVisibilityDays > 30
      ))
    ) {
      throw new AdministrationError('invalid_site_settings', 400);
    }
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.siteSettingsManage);
    const settings = await repository.updateSiteSettings({
      actorId: session.account.id,
      expectedUpdatedAt: parseExpectedUpdatedAt(
        input.expectedUpdatedAt,
        'invalid_site_settings_version',
      ),
      globalRegistrationTokenEnabled: false,
      presenceCounterEnabled: input.presenceCounterEnabled,
      reason: 'Site settings changed',
      shoutboxVisibilityMode: input.shoutboxVisibilityMode,
      updatedAt: clock(),
      ...(countMode
        ? { shoutboxVisibilityCount: input.shoutboxVisibilityCount }
        : { shoutboxVisibilityHours: input.shoutboxVisibilityDays * 24 }),
    });
    if (!settings) {
      throw new AdministrationError('site_settings_update_conflict', 409);
    }
    return settings;
  }

  async function issueUsernameColorUnlock(sessionToken, csrfToken) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.siteSettingsManage);
    const code = unlockCodeFactory();
    const tokenDigest = digestUsernameColorUnlockCode(code);
    const createdAt = clock();
    const expiresAt = new Date(createdAt.getTime() + (30 * 24 * 60 * 60 * 1000));
    await repository.createUsernameColorUnlockCode({
      actorId: session.account.id,
      createdAt,
      expiresAt,
      tokenDigest,
    });
    return { code, expiresAt };
  }

  async function issueRegistrationToken(sessionToken, csrfToken, input) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.siteSettingsManage);
    const issuedAt = clock();
    const prepared = parseRegistrationTokenInput(input, issuedAt);
    const token = inviteTokenFactory();
    const tokenLookupDigest = digestRegistrationInviteToken(token);
    const tokenSalt = inviteSaltFactory();
    const tokenVerifier = await inviteVerifierFactory(token, tokenSalt);
    await repository.createRegistrationInvite({
      actorId: session.account.id,
      createdAt: issuedAt,
      expiresAt: prepared.expiresAt,
      tokenLookupDigest,
      tokenSalt,
      tokenVerifier,
    });
    return {
      createdAt: issuedAt,
      expiresAt: prepared.expiresAt,
      token,
      type: prepared.type,
    };
  }

  async function revokeAllRegistrationTokens(sessionToken, csrfToken, input) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.siteSettingsManage);
    const result = await repository.revokeAllRegistrationTokens({
      actorId: session.account.id,
      expectedUpdatedAt: parseRegistrationTokenRevocationInput(input),
      revokedAt: clock(),
    });
    if (!result) {
      throw new AdministrationError('site_settings_update_conflict', 409);
    }
    return result;
  }

  async function runServerDiagnostic(sessionToken, csrfToken, input, { signal } = {}) {
    const keys = input && !Array.isArray(input) ? Object.keys(input).sort() : [];
    const validLag = input?.operation === 'artificial-lag'
      && keys.join(',') === 'delayMs,operation'
      && Number.isInteger(input.delayMs)
      && input.delayMs >= 0
      && input.delayMs <= maximumDiagnosticLagMs;
    const validShoutbox = input?.operation === 'shoutbox-write-load'
      && keys.join(',') === 'loadLimit,operation,writeCount'
      && Number.isInteger(input.writeCount)
      && input.writeCount >= 1
      && input.writeCount <= maximumDiagnosticShoutboxWrites
      && Number.isInteger(input.loadLimit)
      && input.loadLimit >= 1
      && input.loadLimit <= maximumDiagnosticShoutboxLoad;
    const validNotificationPush = input?.operation === 'notification-push'
      && keys.join(',') === 'notificationCount,operation'
      && Number.isInteger(input.notificationCount)
      && input.notificationCount >= 1
      && input.notificationCount <= maximumDiagnosticNotificationCount;
    if (!validLag && !validShoutbox && !validNotificationPush) {
      throw new AdministrationError('invalid_server_diagnostic', 400);
    }
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.serverDiagnosticsRun);
    if (diagnosticPending) {
      throw new AdministrationError('server_diagnostic_busy', 409);
    }
    diagnosticPending = true;
    const startedAt = diagnosticNow();
    try {
      let result;
      if (validLag) {
        await diagnosticDelay(input.delayMs, signal);
        result = { completed: true, requestedDelayMs: input.delayMs };
      } else if (validShoutbox) {
        result = await repository.runShoutboxDiagnostic({
          actorId: session.account.id,
          createdAt: clock(),
          loadLimit: input.loadLimit,
          writeCount: input.writeCount,
        });
      } else {
        result = await repository.runNotificationPushDiagnostic({
          actorId: session.account.id,
          createdAt: clock(),
          notificationCount: input.notificationCount,
        });
      }
      if (!result) {
        throw new AdministrationError('server_diagnostic_busy', 409);
      }
      const durationMs = Math.max(0, Math.round(diagnosticNow() - startedAt));
      if (validLag) {
        await repository.recordServerDiagnostic({
          action: 'diagnostic.artificial_lag',
          actorId: session.account.id,
          createdAt: clock(),
          details: { durationMs, requestedDelayMs: input.delayMs },
          reason: 'Artificial lag diagnostic run',
        });
      }
      return {
        durationMs,
        operation: input.operation,
        result,
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AdministrationError('server_diagnostic_aborted', 499);
      }
      throw error;
    } finally {
      diagnosticPending = false;
    }
  }

  async function restartForum(sessionToken, csrfToken, input = {}) {
    if (!input || Array.isArray(input) || Object.keys(input).length !== 0) {
      throw new AdministrationError('invalid_forum_restart', 400);
    }
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permissions.forumRestart);
    if (typeof forumRestart !== 'function') {
      throw new AdministrationError('forum_restart_unavailable', 503);
    }
    if (restartPending) {
      throw new AdministrationError('forum_restart_busy', 409);
    }
    restartPending = true;
    const requestedAt = clock();
    try {
      const restartRecord = await repository.recordServerRestart({
        actorId: session.account.id,
        createdAt: requestedAt,
        minimumIntervalMs: forumRestartMinimumIntervalMs,
        reason: 'Forum restart requested',
      });
      if (restartRecord?.status === 'busy') {
        throw new AdministrationError('forum_restart_busy', 409);
      }
      if (restartRecord?.status === 'cooldown') {
        const cooldownError = new AdministrationError('forum_restart_cooldown', 429);
        cooldownError.retryAfterMs = restartRecord.retryAfterMs;
        throw cooldownError;
      }
      if (restartRecord?.status !== 'recorded') {
        throw new Error('invalid_forum_restart_record');
      }
      try {
        await forumRestart({ requestedAt });
      } catch (error) {
        if (
          ['forum_restart_busy', 'forum_restart_cooldown', 'forum_restart_unavailable']
            .includes(error?.code)
        ) {
          const administrationError = new AdministrationError(error.code, error.statusCode);
          administrationError.retryAfterMs = error.retryAfterMs;
          throw administrationError;
        }
        throw error;
      }
      return { requestedAt };
    } finally {
      restartPending = false;
    }
  }

  async function prepareMutation(sessionToken, csrfToken, targetId, input, permission) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    requirePermission(session.account, permission);
    const target = await repository.findManagedAccount(
      session.account.id,
      parseTargetId(targetId),
    );
    if (!target) {
      throw new AdministrationError('account_not_found', 404);
    }
    if (target.membershipStatus === 'deleted') {
      throw new AdministrationError('account_already_deleted', 409);
    }
    if (target.id === session.account.id) {
      throw new AdministrationError('self_moderation_denied', 403);
    }
    if (session.account.role === 'moderator' && target.role !== 'member') {
      throw new AdministrationError('moderation_hierarchy_denied', 403);
    }
    return {
      actor: session.account,
      expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
      target,
    };
  }

  async function runMutation(prepared, action, updates, grants) {
    const result = await repository.manageAccount({
      action,
      actorId: prepared.actor.id,
      expectedUpdatedAt: prepared.expectedUpdatedAt,
      grants,
      reason: mutationAuditReasons.get(action),
      targetId: prepared.target.id,
      updatedAt: clock(),
      updates,
    });
    if (result?.lastAdministrator) {
      throw new AdministrationError('last_administrator', 409);
    }
    if (!result?.account) {
      throw new AdministrationError('account_update_conflict', 409);
    }
    return managedAccountProjection(result.account, isAdministrator(prepared.actor));
  }

  async function updateAccount(sessionToken, csrfToken, targetId, input) {
    const allowedFields = new Set([
      'expectedUpdatedAt',
      'forumPostingMuted',
      'membershipStatus',
      'moderatorPermissions',
      'role',
      'shoutboxPostingMuted',
      'slowdownMs',
    ]);
    const changedFields = Object.keys(input).filter((key) => key !== 'expectedUpdatedAt');
    if (
      changedFields.length === 0
      || Object.keys(input).some((key) => !allowedFields.has(key))
      || (Object.hasOwn(input, 'membershipStatus')
        && !managedMembershipStatuses.has(input.membershipStatus))
      || (Object.hasOwn(input, 'slowdownMs')
        && (!Number.isInteger(input.slowdownMs)
          || input.slowdownMs < 0
          || input.slowdownMs > 300_000))
      || (Object.hasOwn(input, 'forumPostingMuted')
        && typeof input.forumPostingMuted !== 'boolean')
      || (Object.hasOwn(input, 'shoutboxPostingMuted')
        && typeof input.shoutboxPostingMuted !== 'boolean')
      || (Object.hasOwn(input, 'role') && !managedRoles.has(input.role))
      || (Object.hasOwn(input, 'moderatorPermissions') && (
        !Array.isArray(input.moderatorPermissions)
        || new Set(input.moderatorPermissions).size !== input.moderatorPermissions.length
        || input.moderatorPermissions.some((permission) => (
          !grantableModeratorPermissions.includes(permission)
        ))
      ))
    ) {
      throw new AdministrationError('invalid_account_update', 400);
    }
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.usersView,
    );
    if (Object.hasOwn(input, 'membershipStatus') || Object.hasOwn(input, 'slowdownMs')) {
      requirePermission(prepared.actor, permissions.usersModerate);
    }
    if (Object.hasOwn(input, 'forumPostingMuted')) {
      requirePermission(prepared.actor, permissions.postsModerate);
    }
    if (Object.hasOwn(input, 'shoutboxPostingMuted')) {
      requirePermission(prepared.actor, permissions.shoutsModerate);
    }
    if (Object.hasOwn(input, 'role')) {
      requirePermission(prepared.actor, permissions.rolesManage);
      if (prepared.target.role === 'owner') {
        throw new AdministrationError('owner_powers_action_required', 409);
      }
    }
    if (Object.hasOwn(input, 'moderatorPermissions')) {
      requirePermission(prepared.actor, permissions.moderatorGrantsManage);
      if ((input.role ?? prepared.target.role) !== 'moderator') {
        throw new AdministrationError('moderator_required', 409);
      }
    }
    const updates = Object.fromEntries(changedFields
      .filter((key) => key !== 'moderatorPermissions')
      .map((key) => [key, input[key]]));
    return runMutation(
      prepared,
      'account.update',
      updates,
      Object.hasOwn(input, 'moderatorPermissions') ? input.moderatorPermissions : undefined,
    );
  }

  async function setMembershipStatus(sessionToken, csrfToken, targetId, input) {
    if (!managedMembershipStatuses.has(input.membershipStatus)) {
      throw new AdministrationError('invalid_membership_status', 400);
    }
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.usersModerate,
    );
    return runMutation(prepared, 'account.membership', {
      membershipStatus: input.membershipStatus,
    });
  }

  async function forcePasswordReset(sessionToken, csrfToken, targetId, input) {
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.usersModerate,
    );
    return runMutation(prepared, 'account.force_password_reset', { forcePasswordChange: true });
  }

  async function removeAvatar(sessionToken, csrfToken, targetId, input) {
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.usersModerate,
    );
    const result = await repository.clearAccountAvatar({
      actorId: prepared.actor.id,
      expectedUpdatedAt: prepared.expectedUpdatedAt,
      reason: 'Account avatar removed',
      targetId: prepared.target.id,
      updatedAt: clock(),
    });
    if (!result?.account) {
      throw new AdministrationError('account_update_conflict', 409);
    }
    return managedAccountProjection(result.account, isAdministrator(prepared.actor));
  }

  async function deleteAccount(sessionToken, csrfToken, targetId, input) {
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.accountsDelete,
    );
    return runMutation(prepared, 'account.delete', {
      deletedAt: clock(),
      membershipStatus: 'deleted',
    });
  }

  async function removeOwnerPowers(sessionToken, csrfToken, targetId, input) {
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.rolesManage,
    );
    if (prepared.actor.role !== 'dev') {
      throw new AdministrationError('developer_required', 403);
    }
    if (prepared.target.role !== 'owner') {
      throw new AdministrationError('owner_required', 409);
    }
    return runMutation(prepared, 'account.owner_powers_removed', { role: 'member' });
  }

  async function setRole(sessionToken, csrfToken, targetId, input) {
    if (!managedRoles.has(input.role)) {
      throw new AdministrationError('invalid_role', 400);
    }
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.rolesManage,
    );
    if (prepared.target.role === 'owner') {
      throw new AdministrationError('owner_powers_action_required', 409);
    }
    return runMutation(prepared, 'account.role', { role: input.role });
  }

  async function setModeratorGrants(sessionToken, csrfToken, targetId, input) {
    if (
      !Array.isArray(input.permissions)
      || new Set(input.permissions).size !== input.permissions.length
      || input.permissions.some((permission) => !grantableModeratorPermissions.includes(permission))
    ) {
      throw new AdministrationError('invalid_moderator_grants', 400);
    }
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.moderatorGrantsManage,
    );
    if (prepared.target.role !== 'moderator') {
      throw new AdministrationError('moderator_required', 409);
    }
    return runMutation(prepared, 'account.moderator_grants', {}, input.permissions);
  }

  async function setSlowdown(sessionToken, csrfToken, targetId, input) {
    if (!Number.isInteger(input.slowdownMs) || input.slowdownMs < 0 || input.slowdownMs > 300_000) {
      throw new AdministrationError('invalid_slowdown', 400);
    }
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.usersModerate,
    );
    return runMutation(prepared, 'account.slowdown', { slowdownMs: input.slowdownMs });
  }

  async function setForumPostingMute(sessionToken, csrfToken, targetId, input) {
    if (typeof input.muted !== 'boolean') {
      throw new AdministrationError('invalid_forum_posting_mute', 400);
    }
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.postsModerate,
    );
    return runMutation(prepared, 'account.forum_posting_mute', {
      forumPostingMuted: input.muted,
    });
  }

  async function setShoutboxPostingMute(sessionToken, csrfToken, targetId, input) {
    if (typeof input.muted !== 'boolean') {
      throw new AdministrationError('invalid_shoutbox_posting_mute', 400);
    }
    const prepared = await prepareMutation(
      sessionToken,
      csrfToken,
      targetId,
      input,
      permissions.shoutsModerate,
    );
    return runMutation(prepared, 'account.shoutbox_posting_mute', {
      shoutboxPostingMuted: input.muted,
    });
  }

  return {
    decideUsernameRenameRequest,
    deleteAccount,
    forcePasswordReset,
    getSiteSettings,
    getSiteAccessPolicy,
    issueRegistrationToken,
    issueUsernameColorUnlock,
    isPresenceCounterEnabled,
    listAccounts,
    listAudit,
    listAuthenticationAudit,
    listDeletedAccountHistory,
    listContent,
    listUsernameRenameRequests,
    removeAvatar,
    removeOwnerPowers,
    revokeAllRegistrationTokens,
    restartForum,
    runServerDiagnostic,
    setMembershipStatus,
    setForumPostingMute,
    setModeratorGrants,
    setRole,
    setSiteSettings,
    setSiteAccessBlock,
    setSlowdown,
    setShoutboxPostingMute,
    updateAccount,
  };
}