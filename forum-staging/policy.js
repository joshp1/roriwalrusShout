export const permissions = Object.freeze({
  accountsDelete: 'accounts.delete',
  auditView: 'audit.view',
  forumRestart: 'forum.restart',
  moderatorGrantsManage: 'moderator_grants.manage',
  postsModerate: 'posts.moderate',
  rolesManage: 'roles.manage',
  serverDiagnosticsRun: 'server_diagnostics.run',
  shoutsModerate: 'shouts.moderate',
  siteSettingsManage: 'site_settings.manage',
  usersModerate: 'users.moderate',
  usersView: 'users.view',
});

export const grantableModeratorPermissions = Object.freeze([
  permissions.postsModerate,
  permissions.shoutsModerate,
  permissions.usersModerate,
  permissions.usersView,
]);

const definedPermissions = new Set(Object.values(permissions));
const grantablePermissions = new Set(grantableModeratorPermissions);

export class AuthorizationError extends Error {
  constructor() {
    super('permission_denied');
    this.code = 'permission_denied';
    this.statusCode = 403;
  }
}

export function isAdministrator(account) {
  return ['admin', 'dev', 'owner'].includes(account?.role);
}

export function canViewAccount(viewer, subject) {
  return Boolean(subject) && (
    subject.visibleToRole == null || viewer?.role === subject.visibleToRole
  );
}

export function hasPermission(account, permission) {
  return definedPermissions.has(permission) && (
    isAdministrator(account)
    || (
      account?.role === 'moderator'
      && grantablePermissions.has(permission)
      && Array.isArray(account.permissions)
      && account.permissions.includes(permission)
    )
  );
}

export function requirePermission(account, permission) {
  if (!hasPermission(account, permission)) {
    throw new AuthorizationError();
  }
}