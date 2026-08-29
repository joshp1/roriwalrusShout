import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIMEType, TextDecoder } from 'node:util';
import { parseCookie, stringifySetCookie } from 'cookie';
import { AdministrationError, createAdministrationService } from './administration.js';
import { getApiRouteSchema } from './api-schema.js';
import { AuthError, createAuthService, createPasswordHasher } from './auth.js';
import { AvatarError, createAvatarProcessor, maximumAvatarBytes } from './avatar.js';
import {
  AttachmentError,
  createAttachmentProcessor,
  defaultAttachmentAccountQuotaBytes,
  maximumAttachmentBytes,
} from './attachment.js';
import {
  createDatabasePool,
  createDatabaseReadinessCheck,
  createRepository,
} from './database.js';
import { createDirectMessageRepository } from './direct-message-database.js';
import { createDirectMessageService, DirectMessageError } from './direct-messages.js';
import { createForumRepository } from './forum-database.js';
import { createForumRestart, validateForumRestartMarker } from './forum-restart.js';
import { createForumService, ForumError } from './forum.js';
import { createMailer } from './mailer.js';
import { createJsonLogger, createNullLogger } from './logging.js';
import { MentionError } from './mentions.js';
import { assertMigrationsCurrent } from './migrations.js';
import { AuthorizationError, isAdministrator } from './policy.js';
import { canonicalUuidPath } from './uuid.js';
import { createPresenceService, PresenceError } from './presence.js';
import { createProfileService, ProfileError } from './profile.js';
import { createProfilePostRepository } from './profile-post-database.js';
import {
  createFixedWindowLimiter,
  createTrustedProxyAddresses,
  getClientAddress,
} from './request-limits.js';
import {
  attachShoutbox,
  createShoutboxService,
  ShoutboxError,
} from './shoutbox.js';
import {
  createShoutReactionService,
  ShoutReactionError,
} from './shout-reaction.js';
import {
  createWebPushService,
  loadWebPushConfiguration,
  WebPushError,
} from './web-push.js';
import { createWebPushRepository } from './web-push-database.js';

const defaultWebRoot = fileURLToPath(new URL('../../forum-web/src/', import.meta.url));
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const staticDocumentRoutes = new Map([
  ['/', '/index.html'],
  ['/account', '/account.html'],
  ['/members', '/members.html'],
  ['/messages', '/messages.html'],
  ['/moderation', '/admin.html'],
  ['/notifications', '/notifications.html'],
  ['/profile', '/profile.html'],
  ['/rules', '/rules.html'],
  ['/search', '/index.html'],
  ['/shout-reactions', '/shout-reactions.html'],
]);
const legacyStaticDocumentRoutes = new Map(
  [...staticDocumentRoutes].map(([canonicalPath, filePath]) => [filePath, canonicalPath]),
);
legacyStaticDocumentRoutes.set('/index.html', '/');
const retiredStaticDocumentRoutes = new Map([
  ['/admin', '/moderation'],
  ['/settings', '/profile?tab=settings'],
  ['/settings.html', '/profile?tab=settings'],
]);

export function canonicalPublicOrigin(value, { production = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid HTTP or HTTPS origin');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) {
    throw new Error('PUBLIC_ORIGIN must be a canonical HTTP or HTTPS origin without a path');
  }
  if (production && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  }
  return parsed.origin;
}

function getRequestArea(method, pathname) {
  if (!pathname.startsWith('/api/')) return 'static';
  return getApiRouteSchema(method, pathname)?.area ?? 'unknown';
}
const publicStaticPaths = new Set([
  '/account',
  '/account.js',
  '/apple-touch-icon.png',
  '/auth-client.js',
  '/auth-presence-gate.js',
  '/avatar-view.js',
  '/custom-color.js',
  '/deployment-refresh.js',
  '/deployment-status.js',
  '/deployment-status.json',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/favicon.png',
  '/su-chan.webp',
  '/passkey-client.js',
  '/rules',
  '/site-header.js',
  '/site-navigation.js',
  '/stochastic-refresh.js',
  '/styles.css',
  '/service-worker.js',
  '/theme-bootstrap.js',
  '/username-color.js',
  '/vendor/simplewebauthn-browser.js',
  '/web-runtime-version.js',
  '/web-runtime-version.json',
]);
const defaultRequestLimits = Object.freeze({
  api: Object.freeze({ limit: 240, windowMs: 60_000 }),
  auth: Object.freeze({ limit: 30, windowMs: 15 * 60_000 }),
  attachment: Object.freeze({ limit: 20, windowMs: 60 * 60_000 }),
  avatar: Object.freeze({ limit: 10, windowMs: 60 * 60_000 }),
  diagnostics: Object.freeze({ limit: 6, windowMs: 15 * 60_000 }),
});

class RequestError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function applySecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; worker-src 'self'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, statusCode, body) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (statusCode === 204) {
    response.writeHead(statusCode, headers);
    response.end();
    return;
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

function redirectToSignIn(response) {
  response.writeHead(303, {
    'Cache-Control': 'no-store',
    Location: '/account#sign-in',
  });
  response.end();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function isSiteAccessRecoveryPath(pathname) {
  if (
    pathname === '/api/health'
    || pathname === '/api/readiness'
    || pathname === '/api/presence/challenge'
    || (pathname.startsWith('/api/auth/') && pathname !== '/api/auth/static-access')
    || publicStaticPaths.has(pathname)
  ) {
    return true;
  }
  const canonicalPath = retiredStaticDocumentRoutes.get(pathname)
    ?? legacyStaticDocumentRoutes.get(pathname);
  return publicStaticPaths.has(canonicalPath?.split('?')[0]);
}

async function getSiteAccessBlock(request, requestUrl, {
  administrationService,
  authService,
  cookieNames,
}) {
  if (
    isSiteAccessRecoveryPath(requestUrl.pathname)
    || typeof administrationService?.getSiteAccessPolicy !== 'function'
  ) {
    return null;
  }
  const policy = await administrationService.getSiteAccessPolicy();
  if (policy?.blocked !== true) {
    return null;
  }
  const sessionToken = readCookies(request)[cookieNames.session];
  if (sessionToken && typeof authService?.getSession === 'function') {
    try {
      const session = await authService.getSession(sessionToken);
      if (isAdministrator(session.account)) {
        return null;
      }
    } catch (error) {
      if (!(error instanceof AuthError)) {
        throw error;
      }
    }
  }
  return policy;
}

function sendSiteAccessBlocked(request, response, requestUrl, reason) {
  if (requestUrl.pathname.startsWith('/api/')) {
    sendJson(response, 503, { error: 'site_access_blocked', reason });
    return;
  }
  const document = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="theme-color" content="#173f35">
    <link rel="icon" type="image/png" href="/favicon.png">
    <title>Site unavailable | roriwalrus</title>
    <script src="/theme-bootstrap.js"></script>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main class="account-main">
      <section class="account-tool" aria-labelledby="site-access-heading">
        <p class="eyebrow">Site access</p>
        <h1 id="site-access-heading">Temporarily unavailable</h1>
        <p>${escapeHtml(reason)}</p>
        <p><a href="/account#sign-in">Administrator sign in</a></p>
      </section>
    </main>
  </body>
</html>`;
  response.writeHead(503, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(request.method === 'HEAD' ? '' : document);
}

function redirectLegacyStaticDocument(request, response, requestUrl) {
  const canonicalPath = retiredStaticDocumentRoutes.get(requestUrl.pathname)
    ?? legacyStaticDocumentRoutes.get(requestUrl.pathname);
  if (!canonicalPath || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return false;
  }
  const query = requestUrl.search.slice(1);
  response.writeHead(308, {
    'Cache-Control': 'no-store',
    Location: query
      ? `${canonicalPath}${canonicalPath.includes('?') ? '&' : '?'}${query}`
      : canonicalPath,
  });
  response.end();
  return true;
}

async function readJson(request) {
  let contentType;
  try {
    contentType = new MIMEType(request.headers['content-type']);
  } catch {
    throw new RequestError('json_required', 415);
  }
  if (contentType.essence !== 'application/json') {
    throw new RequestError('json_required', 415);
  }
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > 65_536) {
      throw new RequestError('request_too_large', 413);
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || Array.isArray(body) || typeof body !== 'object') {
      throw new Error('JSON object required');
    }
    return body;
  } catch {
    throw new RequestError('invalid_json', 400);
  }
}

async function readBinary(request, maximumBytes, createTooLargeError) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > maximumBytes) {
      throw createTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function encodeDispositionName(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function sendAttachment(response, attachment) {
  response.writeHead(200, {
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeDispositionName(attachment.name)}`,
    'Content-Length': attachment.data.length,
    'Content-Type': attachment.contentType,
  });
  response.end(attachment.data);
}

function sendAvatar(response, avatar) {
  response.writeHead(200, {
    'Cache-Control': 'private, no-store',
    'Content-Length': avatar.data.length,
    'Content-Type': avatar.contentType,
  });
  response.end(avatar.data);
}

async function sendStaticFile(request, response, webRoot, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: 'invalid_path' });
    return;
  }

  const root = resolve(webRoot);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
  let filePath = resolve(root, relativePath);

  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendJson(response, 403, { error: 'forbidden' });
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
    }
    await stat(filePath);
  } catch {
    sendJson(response, 404, { error: 'not_found' });
    return;
  }

  const extension = extname(filePath);
  response.writeHead(200, {
    'Cache-Control': extension === '.html'
      || decodedPath === '/deployment-status.json'
      || decodedPath === '/web-runtime-version.json'
      ? 'no-store'
      : 'no-cache',
    'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

function getCookieNames(secureCookies) {
  return {
    csrf: secureCookies ? '__Host-roriwalrus_csrf' : 'roriwalrus_csrf',
    presence: secureCookies ? '__Host-roriwalrus_presence' : 'roriwalrus_presence',
    session: secureCookies ? '__Host-roriwalrus_session' : 'roriwalrus_session',
  };
}

function readCookies(request) {
  return parseCookie(request.headers.cookie ?? '');
}

function makeCookie(name, value, { httpOnly, maxAge, secureCookies }) {
  return stringifySetCookie({
    httpOnly,
    maxAge,
    name,
    path: '/',
    sameSite: 'lax',
    secure: secureCookies,
    value,
  });
}

function clearAuthenticationCookies(response, cookieNames, secureCookies) {
  response.setHeader('Set-Cookie', [
    makeCookie(cookieNames.session, '', { httpOnly: true, maxAge: 0, secureCookies }),
    makeCookie(cookieNames.csrf, '', { httpOnly: false, maxAge: 0, secureCookies }),
  ]);
}

function setAuthenticationCookies(response, cookieNames, secureCookies, login) {
  const maxAge = login.persistent
    ? Math.floor((login.expiresAt.getTime() - Date.now()) / 1000)
    : undefined;
  response.setHeader('Set-Cookie', [
    makeCookie(cookieNames.session, login.sessionToken, {
      httpOnly: true,
      maxAge,
      secureCookies,
    }),
    makeCookie(cookieNames.csrf, login.csrfToken, {
      httpOnly: false,
      maxAge,
      secureCookies,
    }),
  ]);
}

function requireSameOrigin(request, publicOrigin) {
  const expectedOrigin = publicOrigin ?? `http://${request.headers.host}`;
  if (request.headers.origin !== expectedOrigin) {
    throw new RequestError('invalid_origin', 403);
  }
}

function enforceRequestLimits(request, response, requestUrl, options) {
  if (!requestUrl.pathname.startsWith('/api/')) {
    return true;
  }
  const address = getClientAddress(request, options.trustedProxyAddresses);
  const categories = [['api', options.requestLimits.api]];
  if (
    request.method === 'POST'
    && (
      requestUrl.pathname === '/api/auth/login'
      || requestUrl.pathname === '/api/auth/register'
      || requestUrl.pathname === '/api/auth/verification/resend'
      || requestUrl.pathname.startsWith('/api/auth/password-reset/')
      || requestUrl.pathname.startsWith('/api/auth/passkeys/')
      || requestUrl.pathname.startsWith('/api/account/passkeys')
    )
  ) {
    categories.push(['auth', options.requestLimits.auth]);
  }
  if (request.method === 'PUT' && requestUrl.pathname === '/api/account/avatar') {
    categories.push(['avatar', options.requestLimits.avatar]);
  }
  if (request.method === 'POST' && /^\/api\/posts\/\d+\/attachments$/.test(requestUrl.pathname)) {
    categories.push(['attachment', options.requestLimits.attachment]);
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/admin/server-diagnostics') {
    categories.push(['diagnostics', options.requestLimits.diagnostics]);
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/admin/forum-restart') {
    categories.push(['restart', options.requestLimits.diagnostics]);
  }

  for (const [category, rule] of categories) {
    const result = options.requestLimiter.consume(`${category}:${address}`, rule);
    if (!result.allowed) {
      response.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      sendJson(response, 429, {
        error: 'request_rate_limited',
        retryAfterMs: result.retryAfterMs,
      });
      return false;
    }
  }
  return true;
}

async function routeApi(request, response, requestUrl, options) {
  const {
    authService,
    administrationService,
    attachmentUploadMaxBytes,
    avatarUploadMaxBytes,
    cookieNames,
    directMessageService,
    forumService,
    presenceService,
    profileService,
    publicOrigin,
    readinessCheck,
    secureCookies,
    shoutboxService,
    shoutReactionService,
    webPushService,
  } = options;
  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, { service: 'forum-api', status: 'ok' });
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/readiness') {
    try {
      if (typeof readinessCheck !== 'function' || await readinessCheck() !== true) {
        throw new Error('Service is not ready');
      }
      sendJson(response, 200, { service: 'forum-api', status: 'ready' });
    } catch {
      sendJson(response, 503, { service: 'forum-api', status: 'not_ready' });
    }
    return true;
  }
  if (!requestUrl.pathname.startsWith('/api/')) {
    return false;
  }

  const cookies = readCookies(request);
  const sessionToken = cookies[cookieNames.session];
  let hasActiveSession = false;
  let presenceCounterEnabled;
  async function getPresenceCounterEnabled() {
    if (presenceCounterEnabled === undefined) {
      presenceCounterEnabled = typeof administrationService?.isPresenceCounterEnabled === 'function'
        ? await administrationService.isPresenceCounterEnabled()
        : true;
    }
    return presenceCounterEnabled;
  }
  if (typeof authService?.getSession === 'function' && sessionToken) {
    try {
      await authService.getSession(sessionToken);
      hasActiveSession = true;
    } catch (error) {
      if (!(error instanceof AuthError)) {
        throw error;
      }
    }
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/auth/static-access') {
    if (hasActiveSession) {
      sendJson(response, 204);
    } else {
      redirectToSignIn(response);
    }
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/presence/challenge') {
    const required = !hasActiveSession
      && !presenceService.isComplete(cookies[cookieNames.presence])
      && await getPresenceCounterEnabled();
    sendJson(response, 200, !required
      ? { required: false }
      : presenceService.createChallenge(cookies[cookieNames.presence]));
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/presence/challenge') {
    requireSameOrigin(request, publicOrigin);
    if (!await getPresenceCounterEnabled()) {
      sendJson(response, 204);
      return true;
    }
    const body = await readJson(request);
    const completionToken = presenceService.completeChallenge(body.token);
    response.setHeader('Set-Cookie', makeCookie(cookieNames.presence, completionToken, {
      httpOnly: true,
      maxAge: 12 * 60 * 60,
      secureCookies,
    }));
    sendJson(response, 204);
    return true;
  }
  if (
    presenceService
    && !hasActiveSession
    && !presenceService.isComplete(cookies[cookieNames.presence])
    && await getPresenceCounterEnabled()
  ) {
    sendJson(response, 428, { error: 'presence_required' });
    return true;
  }
  if (!authService) {
    sendJson(response, 503, { error: 'service_unavailable' });
    return true;
  }
  if (!getApiRouteSchema(request.method, requestUrl.pathname)) {
    requireSameOrigin(request, publicOrigin);
    sendJson(response, 404, { error: 'not_found' });
    return true;
  }

  const csrfToken = request.headers['x-csrf-token'];

  const shoutReactionsMatch = requestUrl.pathname.match(/^\/api\/shouts\/(\d+)\/reactions$/);
  if (request.method === 'GET' && shoutReactionsMatch) {
    sendJson(response, 200, await shoutReactionService.listReactions(
      sessionToken,
      shoutReactionsMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
        reaction: requestUrl.searchParams.get('reaction'),
      },
    ));
    return true;
  }

  const shoutLocationMatch = requestUrl.pathname.match(/^\/api\/shouts\/(\d+)\/location$/);
  if (request.method === 'GET' && shoutLocationMatch) {
    sendJson(response, 200, await shoutboxService.locateShout(
      sessionToken,
      shoutLocationMatch[1],
      { stream: requestUrl.searchParams.get('stream') },
    ));
    return true;
  }

  const shoutFlagsMatch = requestUrl.pathname.match(/^\/api\/shouts\/(\d+)\/flags$/);
  if (request.method === 'GET' && shoutFlagsMatch) {
    sendJson(response, 200, await shoutboxService.listFlags(
      sessionToken,
      shoutFlagsMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
        stream: requestUrl.searchParams.get('stream'),
      },
    ));
    return true;
  }

  const postReactionsMatch = requestUrl.pathname.match(/^\/api\/posts\/(\d+)\/reactions$/);
  if (request.method === 'GET' && postReactionsMatch) {
    sendJson(response, 200, await forumService.listPostReactions(
      sessionToken,
      postReactionsMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
        reaction: requestUrl.searchParams.get('reaction'),
      },
    ));
    return true;
  }

  const avatarMatch = requestUrl.pathname.match(
    new RegExp(`^/api/avatars/(${canonicalUuidPath})$`, 'i'),
  );
  if (request.method === 'GET' && avatarMatch) {
    const session = await authService.getSession(sessionToken);
    const avatar = await authService.getAvatar(session.account.id, avatarMatch[1]);
    if (!avatar) {
      throw new AuthError('avatar_not_found', 404);
    }
    sendAvatar(response, avatar);
    return true;
  }

  const attachmentMatch = requestUrl.pathname.match(/^\/api\/attachments\/(\d+)$/);
  if (request.method === 'GET' && attachmentMatch) {
    const attachment = await forumService.getPostAttachment(sessionToken, attachmentMatch[1]);
    sendAttachment(response, attachment);
    return true;
  }
  if (request.method === 'DELETE' && attachmentMatch) {
    const attachment = await forumService.deletePostAttachment(
      sessionToken,
      csrfToken,
      attachmentMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { attachment });
    return true;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/auth/session') {
    const session = await authService.getSession(sessionToken);
    sendJson(response, 200, { account: session.account });
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/account/sessions') {
    sendJson(response, 200, { sessions: await authService.listSessions(sessionToken) });
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/account/passkeys') {
    sendJson(response, 200, { passkeys: await authService.listPasskeys(sessionToken) });
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/notifications') {
    sendJson(response, 200, await authService.listNotifications(sessionToken, {
      limit: requestUrl.searchParams.get('limit'),
      offset: requestUrl.searchParams.get('offset'),
    }));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/push/configuration') {
    sendJson(response, 200, await webPushService.getConfiguration(sessionToken));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/direct-messages') {
    sendJson(response, 200, await directMessageService.listThreads(sessionToken, {
      limit: requestUrl.searchParams.get('limit'),
      offset: requestUrl.searchParams.get('offset'),
    }));
    return true;
  }
  const directMessageMatch = requestUrl.pathname.match(/^\/api\/direct-messages\/(\d+)$/);
  if (request.method === 'GET' && directMessageMatch) {
    sendJson(response, 200, await directMessageService.getThread(
      sessionToken,
      directMessageMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        mode: requestUrl.searchParams.get('mode'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  const directMessageLocationMatch = requestUrl.pathname.match(
    /^\/api\/direct-messages\/(\d+)\/messages\/(\d+)\/location$/,
  );
  if (request.method === 'GET' && directMessageLocationMatch) {
    sendJson(response, 200, await directMessageService.locateMessage(
      sessionToken,
      directMessageLocationMatch[1],
      directMessageLocationMatch[2],
      { mode: requestUrl.searchParams.get('mode') },
    ));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/forum/search') {
    sendJson(response, 200, await forumService.searchContent(sessionToken, {
      limit: requestUrl.searchParams.get('limit'),
      offset: requestUrl.searchParams.get('offset'),
      q: requestUrl.searchParams.get('q'),
    }));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/topics') {
    sendJson(response, 200, await forumService.listTopics(sessionToken, {
      limit: requestUrl.searchParams.get('limit'),
      offset: requestUrl.searchParams.get('offset'),
      subforum: requestUrl.searchParams.get('subforum'),
    }));
    return true;
  }
  const topicMatch = requestUrl.pathname.match(/^\/api\/topics\/(\d+)$/);
  if (request.method === 'GET' && topicMatch) {
    sendJson(response, 200, await forumService.getTopic(sessionToken, topicMatch[1], {
      limit: requestUrl.searchParams.get('limit'),
      offset: requestUrl.searchParams.get('offset'),
    }));
    return true;
  }
  const deletedPostMatch = requestUrl.pathname.match(/^\/api\/posts\/(\d+)\/deleted$/);
  if (request.method === 'GET' && deletedPostMatch) {
    sendJson(response, 200, await forumService.inspectDeletedPost(
      sessionToken,
      deletedPostMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/profiles') {
    sendJson(response, 200, await profileService.searchMentionUsernames(
      sessionToken,
      requestUrl.searchParams.get('prefix'),
    ));
    return true;
  }
  if (
    request.method === 'GET'
    && requestUrl.pathname === '/api/account/username-rename-requests'
  ) {
    sendJson(response, 200, await profileService.listUsernameRenameRequests(sessionToken));
    return true;
  }
  const profilePostsMatch = requestUrl.pathname.match(/^\/api\/profiles\/([^/]+)\/posts$/);
  const profileFollowersMatch = requestUrl.pathname.match(
    /^\/api\/profiles\/([^/]+)\/followers$/,
  );
  const profileVisitorPostsMatch = requestUrl.pathname.match(
    /^\/api\/profiles\/([^/]+)\/visitor-posts$/,
  );
  const profilePostCommentsMatch = requestUrl.pathname.match(
    /^\/api\/profile-posts\/(\d+)\/comments$/,
  );
  const profileVisitorPostCommentsMatch = requestUrl.pathname.match(
    /^\/api\/profile-visitor-posts\/(\d+)\/comments$/,
  );
  if (request.method === 'GET' && profileFollowersMatch) {
    let username;
    try {
      username = decodeURIComponent(profileFollowersMatch[1]);
    } catch {
      throw new RequestError('invalid_path', 400);
    }
    sendJson(response, 200, await profileService.listProfileFollowers(
      sessionToken,
      username,
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  if (request.method === 'GET' && profilePostsMatch) {
    let username;
    try {
      username = decodeURIComponent(profilePostsMatch[1]);
    } catch {
      throw new RequestError('invalid_path', 400);
    }
    sendJson(response, 200, await profileService.listProfilePosts(sessionToken, username, {
      limit: requestUrl.searchParams.get('limit'),
      offset: requestUrl.searchParams.get('offset'),
    }));
    return true;
  }
  if (request.method === 'GET' && profileVisitorPostsMatch) {
    let username;
    try {
      username = decodeURIComponent(profileVisitorPostsMatch[1]);
    } catch {
      throw new RequestError('invalid_path', 400);
    }
    sendJson(response, 200, await profileService.listProfileVisitorPosts(
      sessionToken,
      username,
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  if (request.method === 'GET' && profilePostCommentsMatch) {
    sendJson(response, 200, await profileService.listProfilePostComments(
      sessionToken,
      profilePostCommentsMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  if (request.method === 'GET' && profileVisitorPostCommentsMatch) {
    sendJson(response, 200, await profileService.listProfileVisitorPostComments(
      sessionToken,
      profileVisitorPostCommentsMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  const profileMatch = requestUrl.pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (request.method === 'GET' && profileMatch) {
    let username;
    try {
      username = decodeURIComponent(profileMatch[1]);
    } catch {
      throw new RequestError('invalid_path', 400);
    }
    sendJson(response, 200, await profileService.getProfile(sessionToken, username));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/admin/accounts') {
    sendJson(response, 200, await administrationService.listAccounts(sessionToken, {
      limit: requestUrl.searchParams.get('limit'),
      offset: requestUrl.searchParams.get('offset'),
    }));
    return true;
  }
  if (
    request.method === 'GET'
    && requestUrl.pathname === '/api/admin/username-rename-requests'
  ) {
    sendJson(response, 200, await administrationService.listUsernameRenameRequests(
      sessionToken,
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/admin/site-settings') {
    const settings = await administrationService.getSiteSettings(sessionToken);
    sendJson(response, 200, { settings });
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/admin/authentication-audit') {
    sendJson(response, 200, await administrationService.listAuthenticationAudit(
      sessionToken,
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/admin/deleted-account-history') {
    sendJson(response, 200, await administrationService.listDeletedAccountHistory(
      sessionToken,
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  const adminAuditMatch = requestUrl.pathname.match(
    new RegExp(`^/api/admin/accounts/(${canonicalUuidPath})/audit$`, 'i'),
  );
  if (request.method === 'GET' && adminAuditMatch) {
    sendJson(response, 200, await administrationService.listAudit(
      sessionToken,
      adminAuditMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }
  const adminContentMatch = requestUrl.pathname.match(
    new RegExp(`^/api/admin/accounts/(${canonicalUuidPath})/content$`, 'i'),
  );
  if (request.method === 'GET' && adminContentMatch) {
    sendJson(response, 200, await administrationService.listContent(
      sessionToken,
      adminContentMatch[1],
      {
        limit: requestUrl.searchParams.get('limit'),
        offset: requestUrl.searchParams.get('offset'),
      },
    ));
    return true;
  }

  requireSameOrigin(request, publicOrigin);
  if (request.method === 'POST' && shoutFlagsMatch) {
    const flag = await shoutboxService.createFlag(
      sessionToken,
      csrfToken,
      shoutFlagsMatch[1],
      await readJson(request),
    );
    sendJson(response, 201, { flag });
    return true;
  }
  const shoutFlagDecisionMatch = requestUrl.pathname.match(/^\/api\/shout-flags\/(\d+)$/);
  if (request.method === 'PATCH' && shoutFlagDecisionMatch) {
    const flag = await shoutboxService.decideFlag(
      sessionToken,
      csrfToken,
      shoutFlagDecisionMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { flag });
    return true;
  }
  if (
    request.method === 'POST'
    && requestUrl.pathname === '/api/account/username-rename-requests'
  ) {
    sendJson(response, 201, await profileService.createUsernameRenameRequest(
      sessionToken,
      csrfToken,
      await readJson(request),
    ));
    return true;
  }
  if (request.method === 'PATCH' && requestUrl.pathname === '/api/admin/site-access-block') {
    const settings = await administrationService.setSiteAccessBlock(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 200, { settings });
    return true;
  }
  if (request.method === 'PATCH' && requestUrl.pathname === '/api/admin/site-settings') {
    const settings = await administrationService.setSiteSettings(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 200, { settings });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/admin/username-color-unlocks') {
    const unlock = await administrationService.issueUsernameColorUnlock(
      sessionToken,
      csrfToken,
    );
    sendJson(response, 201, { unlock });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/admin/registration-tokens') {
    const registrationToken = await administrationService.issueRegistrationToken(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 201, { registrationToken });
    return true;
  }
  if (request.method === 'DELETE' && requestUrl.pathname === '/api/admin/registration-tokens') {
    const revocation = await administrationService.revokeAllRegistrationTokens(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 200, { revocation });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/admin/server-diagnostics') {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    let diagnostic;
    try {
      diagnostic = await administrationService.runServerDiagnostic(
        sessionToken,
        csrfToken,
        await readJson(request),
        { signal: abortController.signal },
      );
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
    sendJson(response, 200, { diagnostic });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/admin/forum-restart') {
    const restart = await administrationService.restartForum(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 202, { restart });
    return true;
  }
  const adminUsernameRenameMatch = requestUrl.pathname.match(
    /^\/api\/admin\/username-rename-requests\/(\d+)$/,
  );
  if (request.method === 'PATCH' && adminUsernameRenameMatch) {
    const requestResult = await administrationService.decideUsernameRenameRequest(
      sessionToken,
      csrfToken,
      adminUsernameRenameMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { request: requestResult });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/direct-messages') {
    const thread = await directMessageService.createThread(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 201, { thread });
    return true;
  }
  const directMessageMessageMatch = requestUrl.pathname.match(
    /^\/api\/direct-messages\/messages\/(\d+)$/,
  );
  if (request.method === 'PATCH' && directMessageMessageMatch) {
    const message = await directMessageService.editMessage(
      sessionToken,
      csrfToken,
      directMessageMessageMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { message });
    return true;
  }
  if (request.method === 'DELETE' && directMessageMessageMatch) {
    const message = await directMessageService.deleteMessage(
      sessionToken,
      csrfToken,
      directMessageMessageMatch[1],
      { mode: requestUrl.searchParams.get('mode') },
    );
    sendJson(response, 200, { message });
    return true;
  }
  const directMessageActionMatch = requestUrl.pathname.match(
    /^\/api\/direct-messages\/(\d+)\/(invite|leave|lock|messages|read)$/,
  );
  if (
    request.method === 'PUT'
    && directMessageActionMatch
    && directMessageActionMatch[2] === 'read'
  ) {
    sendJson(response, 200, await directMessageService.markThreadRead(
      sessionToken,
      csrfToken,
      directMessageActionMatch[1],
      {
        mode: requestUrl.searchParams.get('mode'),
        through: requestUrl.searchParams.get('through'),
      },
    ));
    return true;
  }
  if (request.method === 'POST' && directMessageActionMatch) {
    const [, threadId, action] = directMessageActionMatch;
    if (action === 'messages') {
      const message = await directMessageService.createMessage(
        sessionToken, csrfToken, threadId, await readJson(request),
      );
      sendJson(response, 201, { message });
      return true;
    }
    if (action === 'invite') {
      const thread = await directMessageService.inviteMember(
        sessionToken, csrfToken, threadId, await readJson(request),
      );
      sendJson(response, 200, { thread });
      return true;
    }
    if (action === 'leave') {
      sendJson(response, 200, await directMessageService.leaveThread(
        sessionToken, csrfToken, threadId,
      ));
      return true;
    }
    if (action === 'lock') {
      const thread = await directMessageService.lockThread(sessionToken, csrfToken, threadId);
      sendJson(response, 200, { thread });
      return true;
    }
  }
  const accountSessionMatch = requestUrl.pathname.match(
    new RegExp(`^/api/account/sessions/(${canonicalUuidPath})$`, 'i'),
  );
  if (request.method === 'DELETE' && accountSessionMatch) {
      const result = await authService.revokeAccountSession(
      sessionToken,
      csrfToken,
      accountSessionMatch[1],
    );
    if (result.current) {
      clearAuthenticationCookies(response, cookieNames, secureCookies);
    }
    sendJson(response, 200, result);
    return true;
  }
  const accountPasskeyMatch = requestUrl.pathname.match(
    /^\/api\/account\/passkeys\/([A-Za-z0-9_-]{1,1364})$/,
  );
  if (request.method === 'PATCH' && accountPasskeyMatch) {
    const passkey = await authService.renamePasskey(
      sessionToken,
      csrfToken,
      accountPasskeyMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { passkey });
    return true;
  }
  if (request.method === 'DELETE' && accountPasskeyMatch) {
    const result = await authService.removePasskey(
      sessionToken,
      csrfToken,
      accountPasskeyMatch[1],
      await readJson(request),
    );
    if (result.currentSessionRevoked) {
      clearAuthenticationCookies(response, cookieNames, secureCookies);
    }
    sendJson(response, 200, result);
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/topics') {
    const created = await forumService.createTopic(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 201, created);
    return true;
  }
  const topicSubscriptionMatch = requestUrl.pathname.match(
    /^\/api\/topics\/(\d+)\/subscription$/,
  );
  if (['DELETE', 'PUT'].includes(request.method) && topicSubscriptionMatch) {
    const subscription = await forumService.setTopicSubscription(
      sessionToken,
      csrfToken,
      topicSubscriptionMatch[1],
      request.method === 'PUT',
    );
    sendJson(response, 200, { subscription });
    return true;
  }
  if (request.method === 'PATCH' && topicMatch) {
    const topic = await forumService.editTopic(
      sessionToken,
      csrfToken,
      topicMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { topic });
    return true;
  }
  if (request.method === 'DELETE' && topicMatch) {
    const topic = await forumService.deleteTopic(
      sessionToken,
      csrfToken,
      topicMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { topic });
    return true;
  }
  const topicPostsMatch = requestUrl.pathname.match(/^\/api\/topics\/(\d+)\/posts$/);
  if (request.method === 'POST' && topicPostsMatch) {
    const post = await forumService.createPost(
      sessionToken,
      csrfToken,
      topicPostsMatch[1],
      await readJson(request),
    );
    sendJson(response, 201, { post });
    return true;
  }
  const postAttachmentsMatch = requestUrl.pathname.match(/^\/api\/posts\/(\d+)\/attachments$/);
  if (request.method === 'POST' && postAttachmentsMatch) {
    let name;
    try {
      name = decodeURIComponent(request.headers['x-attachment-name'] ?? '');
    } catch {
      throw new ForumError('invalid_attachment_name', 400);
    }
    const attachment = await forumService.createPostAttachment(
      sessionToken,
      csrfToken,
      postAttachmentsMatch[1],
      {
        data: () => readBinary(
          request,
          attachmentUploadMaxBytes,
          () => new AttachmentError('attachment_too_large', 413),
        ),
        name,
      },
    );
    sendJson(response, 201, { attachment });
    return true;
  }
  if (['DELETE', 'PUT'].includes(request.method) && postReactionsMatch) {
    const post = request.method === 'PUT'
      ? await forumService.setPostReaction(
        sessionToken,
        csrfToken,
        postReactionsMatch[1],
        await readJson(request),
      )
      : await forumService.clearPostReaction(
        sessionToken,
        csrfToken,
        postReactionsMatch[1],
      );
    sendJson(response, 200, { post });
    return true;
  }
  const topicLockMatch = requestUrl.pathname.match(/^\/api\/topics\/(\d+)\/lock$/);
  if (request.method === 'PATCH' && topicLockMatch) {
    const body = await readJson(request);
    const topic = await forumService.setTopicLocked(
      sessionToken,
      csrfToken,
      topicLockMatch[1],
      body.locked,
    );
    sendJson(response, 200, { topic });
    return true;
  }
  const postMatch = requestUrl.pathname.match(/^\/api\/posts\/(\d+)$/);
  if (request.method === 'PATCH' && postMatch) {
    const post = await forumService.editPost(
      sessionToken,
      csrfToken,
      postMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { post });
    return true;
  }
  if (request.method === 'DELETE' && postMatch) {
    const post = await forumService.deletePost(
      sessionToken,
      csrfToken,
      postMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { post });
    return true;
  }
  const postRestoreMatch = requestUrl.pathname.match(/^\/api\/posts\/(\d+)\/restore$/);
  if (request.method === 'POST' && postRestoreMatch) {
    const post = await forumService.restorePost(
      sessionToken,
      csrfToken,
      postRestoreMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { post });
    return true;
  }
  if (request.method === 'PATCH' && requestUrl.pathname === '/api/account/profile') {
    const profile = await profileService.updateProfile(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 200, { profile });
    return true;
  }
  if (request.method === 'POST' && profilePostsMatch) {
    let username;
    try {
      username = decodeURIComponent(profilePostsMatch[1]);
    } catch {
      throw new RequestError('invalid_path', 400);
    }
    const post = await profileService.createProfilePost(
      sessionToken,
      csrfToken,
      username,
      await readJson(request),
    );
    sendJson(response, 201, { post });
    return true;
  }
  if (request.method === 'POST' && profilePostCommentsMatch) {
    const comment = await profileService.createProfilePostComment(
      sessionToken,
      csrfToken,
      profilePostCommentsMatch[1],
      await readJson(request),
    );
    sendJson(response, 201, { comment });
    return true;
  }
  if (request.method === 'POST' && profileVisitorPostCommentsMatch) {
    const comment = await profileService.createProfileVisitorPostComment(
      sessionToken,
      csrfToken,
      profileVisitorPostCommentsMatch[1],
      await readJson(request),
    );
    sendJson(response, 201, { comment });
    return true;
  }
  if (request.method === 'POST' && profileVisitorPostsMatch) {
    let username;
    try {
      username = decodeURIComponent(profileVisitorPostsMatch[1]);
    } catch {
      throw new RequestError('invalid_path', 400);
    }
    const post = await profileService.createProfileVisitorPost(
      sessionToken,
      csrfToken,
      username,
      await readJson(request),
    );
    sendJson(response, 201, { post });
    return true;
  }
  const profilePostMatch = requestUrl.pathname.match(/^\/api\/profile-posts\/(\d+)$/);
  const profilePostCommentMatch = requestUrl.pathname.match(
    /^\/api\/profile-post-comments\/(\d+)$/,
  );
  const profileVisitorPostMatch = requestUrl.pathname.match(
    /^\/api\/profile-visitor-posts\/(\d+)$/,
  );
  const profileVisitorPostCommentMatch = requestUrl.pathname.match(
    /^\/api\/profile-visitor-post-comments\/(\d+)$/,
  );
  const profileContentMatch = profilePostMatch
    ?? profilePostCommentMatch
    ?? profileVisitorPostMatch
    ?? profileVisitorPostCommentMatch;
  if (profileContentMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const kind = profilePostMatch
      ? 'profile_post'
      : profilePostCommentMatch
        ? 'profile_post_comment'
        : profileVisitorPostMatch
          ? 'profile_visitor_post'
          : 'profile_visitor_post_comment';
    const item = request.method === 'PATCH'
      ? await profileService.editProfileContent(
        sessionToken,
        csrfToken,
        profileContentMatch[1],
        await readJson(request),
        kind,
      )
      : await profileService.deleteProfileContent(
        sessionToken,
        csrfToken,
        profileContentMatch[1],
        kind,
      );
    sendJson(response, 200, { item });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/account/username-color-unlock') {
    const unlock = await profileService.redeemUsernameColorUnlock(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 200, { unlock });
    return true;
  }
  if ((request.method === 'PUT' || request.method === 'DELETE') && profileMatch) {
    let username;
    try {
      username = decodeURIComponent(profileMatch[1]);
    } catch {
      throw new RequestError('invalid_path', 400);
    }
    const profile = await profileService.setFollowing(
      sessionToken,
      csrfToken,
      username,
      request.method === 'PUT',
    );
    sendJson(response, 200, { profile });
    return true;
  }
  const adminAccountMatch = requestUrl.pathname.match(
    new RegExp(`^/api/admin/accounts/(${canonicalUuidPath})$`, 'i'),
  );
  const adminActionMatch = requestUrl.pathname.match(
    new RegExp(`^/api/admin/accounts/(${canonicalUuidPath})/(avatar|forum-mute|membership|force-password-reset|moderator-grants|owner-powers|role|shoutbox-mute|slowdown)$`, 'i'),
  );
  if (request.method === 'PATCH' && adminAccountMatch) {
    const account = await administrationService.updateAccount(
      sessionToken,
      csrfToken,
      adminAccountMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { account });
    return true;
  }
  if (request.method === 'DELETE' && adminAccountMatch) {
    const account = await administrationService.deleteAccount(
      sessionToken,
      csrfToken,
      adminAccountMatch[1],
      await readJson(request),
    );
    sendJson(response, 200, { account });
    return true;
  }
  if (adminActionMatch) {
    const [, targetId, action] = adminActionMatch;
    const body = await readJson(request);
    let account;
    if (request.method === 'PATCH' && action === 'membership') {
      account = await administrationService.setMembershipStatus(
        sessionToken, csrfToken, targetId, body,
      );
    } else if (request.method === 'POST' && action === 'force-password-reset') {
      account = await administrationService.forcePasswordReset(
        sessionToken, csrfToken, targetId, body,
      );
    } else if (request.method === 'DELETE' && action === 'avatar') {
      account = await administrationService.removeAvatar(
        sessionToken, csrfToken, targetId, body,
      );
    } else if (request.method === 'DELETE' && action === 'owner-powers') {
      account = await administrationService.removeOwnerPowers(
        sessionToken, csrfToken, targetId, body,
      );
    } else if (request.method === 'PUT' && action === 'moderator-grants') {
      account = await administrationService.setModeratorGrants(
        sessionToken, csrfToken, targetId, body,
      );
    } else if (request.method === 'PATCH' && action === 'role') {
      account = await administrationService.setRole(sessionToken, csrfToken, targetId, body);
    } else if (request.method === 'PATCH' && action === 'slowdown') {
      account = await administrationService.setSlowdown(sessionToken, csrfToken, targetId, body);
    } else if (request.method === 'PATCH' && action === 'forum-mute') {
      account = await administrationService.setForumPostingMute(
        sessionToken, csrfToken, targetId, body,
      );
    } else if (request.method === 'PATCH' && action === 'shoutbox-mute') {
      account = await administrationService.setShoutboxPostingMute(
        sessionToken, csrfToken, targetId, body,
      );
    }
    if (account) {
      sendJson(response, 200, { account });
      return true;
    }
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/register') {
    await authService.register(await readJson(request));
    sendJson(response, 202, { status: 'verification_sent' });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/verify-email') {
    const body = await readJson(request);
    await authService.verifyEmail(body.token);
    sendJson(response, 204);
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/verification/resend') {
    const body = await readJson(request);
    await authService.resendVerification(body.email);
    sendJson(response, 202, { status: 'verification_sent' });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/login') {
    const login = await authService.login(await readJson(request), {
      userAgent: request.headers['user-agent'],
    });
    setAuthenticationCookies(response, cookieNames, secureCookies, login);
    sendJson(response, 200, { account: login.account });
    return true;
  }
  if (
    request.method === 'POST'
    && requestUrl.pathname === '/api/auth/passkeys/authentication-options'
  ) {
    sendJson(response, 200, await authService.createPasskeyAuthenticationOptions());
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/passkeys/authenticate') {
    const login = await authService.loginWithPasskey(await readJson(request), {
      clientAddress: getClientAddress(request, options.trustedProxyAddresses),
      userAgent: request.headers['user-agent'],
    });
    setAuthenticationCookies(response, cookieNames, secureCookies, login);
    sendJson(response, 200, { account: login.account });
    return true;
  }
  if (
    request.method === 'POST'
    && requestUrl.pathname === '/api/account/passkeys/registration-options'
  ) {
    sendJson(response, 200, await authService.createPasskeyRegistrationOptions(
      sessionToken,
      csrfToken,
      await readJson(request),
    ));
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/account/passkeys') {
    const passkey = await authService.registerPasskey(
      sessionToken,
      csrfToken,
      await readJson(request),
    );
    sendJson(response, 201, { passkey });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/logout') {
    await authService.logout(sessionToken, csrfToken);
    clearAuthenticationCookies(response, cookieNames, secureCookies);
    sendJson(response, 204);
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/logout-all') {
    await authService.logoutAll(sessionToken, csrfToken);
    clearAuthenticationCookies(response, cookieNames, secureCookies);
    sendJson(response, 204);
    return true;
  }
  if (request.method === 'PUT' && requestUrl.pathname === '/api/account/avatar') {
    const account = await authService.updateAvatar(
      sessionToken,
      csrfToken,
      await readBinary(
        request,
        avatarUploadMaxBytes,
        () => new AvatarError('avatar_too_large', 413),
      ),
    );
    sendJson(response, 200, { account });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/password-reset/request') {
    const body = await readJson(request);
    await authService.requestPasswordReset(body.email);
    sendJson(response, 202, { status: 'reset_sent' });
    return true;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/password-reset/confirm') {
    await authService.resetPassword(await readJson(request));
    sendJson(response, 204);
    return true;
  }
  if (request.method === 'PATCH' && requestUrl.pathname === '/api/preferences') {
    const preferences = await authService.updatePreferences(sessionToken, csrfToken, await readJson(request));
    sendJson(response, 200, { preferences });
    return true;
  }
  if (request.method === 'PUT' && requestUrl.pathname === '/api/push/subscription') {
    sendJson(response, 200, await webPushService.subscribe(
      sessionToken,
      csrfToken,
      await readJson(request),
    ));
    return true;
  }
  if (request.method === 'DELETE' && requestUrl.pathname === '/api/push/subscription') {
    sendJson(response, 200, await webPushService.unsubscribe(
      sessionToken,
      csrfToken,
      await readJson(request),
    ));
    return true;
  }
  if (request.method === 'PUT' && requestUrl.pathname === '/api/notifications/read') {
    sendJson(response, 200, await authService.markAllNotificationsRead(sessionToken, csrfToken));
    return true;
  }
  const notificationMatch = requestUrl.pathname.match(/^\/api\/notifications\/(\d+)$/);
  if (request.method === 'PATCH' && notificationMatch) {
    const body = await readJson(request);
    const notification = await authService.setNotificationRead(
      sessionToken,
      csrfToken,
      notificationMatch[1],
      body.read,
    );
    sendJson(response, 200, { notification });
    return true;
  }

  sendJson(response, 404, { error: 'not_found' });
  return true;
}

export function createForumServer({
  administrationService,
  attachmentUploadMaxBytes = maximumAttachmentBytes,
  authService,
  avatarUploadMaxBytes = maximumAvatarBytes,
  directMessageService,
  forumService,
  logger = createNullLogger(),
  presenceService,
  profileService,
  publicOrigin,
  readinessCheck,
  requestLimiter = createFixedWindowLimiter(),
  requestClock = () => Date.now(),
  requestIdFactory = randomUUID,
  requestLimits = defaultRequestLimits,
  secureCookies = publicOrigin?.startsWith('https://') ?? false,
  shoutboxService,
  shoutReactionService,
  trustedProxyAddresses = new Set(),
  webPushService,
  webRoot = process.env.WEB_ROOT ?? defaultWebRoot,
} = {}) {
  const cookieNames = getCookieNames(secureCookies);
  const server = createServer({
    headersTimeout: 10_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 16_384,
    requestTimeout: 15_000,
  }, async (request, response) => {
    const requestId = requestIdFactory();
    const startedAt = requestClock();
    let area = 'unknown';
    let terminalLogged = false;
    response.setHeader('X-Request-ID', requestId);
    function logTerminal(aborted) {
      if (terminalLogged) return;
      terminalLogged = true;
      const input = {
        area,
        durationMs: Math.max(0, requestClock() - startedAt),
        method: request.method,
        requestId,
        statusCode: response.statusCode,
      };
      if (aborted) logger.httpRequestAborted(input);
      else logger.httpRequestCompleted(input);
    }
    response.once('finish', () => logTerminal(false));
    response.once('close', () => {
      if (!response.writableFinished) logTerminal(true);
    });
    applySecurityHeaders(response);
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      area = getRequestArea(request.method, requestUrl.pathname);
      if (!enforceRequestLimits(request, response, requestUrl, {
        requestLimiter,
        requestLimits,
        trustedProxyAddresses,
      })) {
        return;
      }
      const siteAccessBlock = await getSiteAccessBlock(request, requestUrl, {
        administrationService,
        authService,
        cookieNames,
      });
      if (siteAccessBlock) {
        sendSiteAccessBlocked(
          request,
          response,
          requestUrl,
          siteAccessBlock.reason || 'Site access is temporarily unavailable.',
        );
        return;
      }
      const handled = await routeApi(request, response, requestUrl, {
        administrationService,
        attachmentUploadMaxBytes,
        authService,
        avatarUploadMaxBytes,
        cookieNames,
        directMessageService,
        forumService,
        presenceService,
        profileService,
        publicOrigin,
        readinessCheck,
        secureCookies,
        shoutboxService,
        shoutReactionService,
        webPushService,
      });
      if (!handled) {
        if (redirectLegacyStaticDocument(request, response, requestUrl)) {
          return;
        }
        if (!publicStaticPaths.has(requestUrl.pathname)) {
          if (!authService) {
            sendJson(response, 503, { error: 'service_unavailable' });
            return;
          }
          try {
            const cookies = readCookies(request);
            await authService.getSession(cookies[cookieNames.session]);
          } catch (error) {
            if (error instanceof AuthError && error.statusCode === 401) {
              redirectToSignIn(response);
              return;
            }
            throw error;
          }
        }
        await sendStaticFile(
          request,
          response,
          webRoot,
          staticDocumentRoutes.get(requestUrl.pathname) ?? requestUrl.pathname,
        );
      }
    } catch (error) {
      if (
        error instanceof AdministrationError
        || error instanceof AttachmentError
        || error instanceof AuthError
        || error instanceof AuthorizationError
        || error instanceof AvatarError
        || error instanceof DirectMessageError
        || error instanceof ForumError
        || error instanceof MentionError
        || error instanceof PresenceError
        || error instanceof ProfileError
        || error instanceof ShoutReactionError
        || error instanceof ShoutboxError
        || error instanceof WebPushError
        || error instanceof RequestError
      ) {
        const body = { error: error.code };
        if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
          body.retryAfterMs = error.retryAfterMs;
          response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
        }
        sendJson(response, error.statusCode, body);
        return;
      }
      logger.httpRequestFailed({ error, requestId });
      sendJson(response, 500, { error: 'internal_error' });
    }
  });
  server.maxConnections = 256;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  return server;
}

export async function startServer({ logger = createJsonLogger() } = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const publicOrigin = canonicalPublicOrigin(
    process.env.PUBLIC_ORIGIN ?? `http://${host}:${port}`,
    { production: process.env.NODE_ENV === 'production' },
  );
  const configuredAvatarBytes = Number.parseInt(
    process.env.AVATAR_UPLOAD_MAX_BYTES ?? String(maximumAvatarBytes),
    10,
  );
  const avatarUploadMaxBytes = Number.isSafeInteger(configuredAvatarBytes) && configuredAvatarBytes > 0
    ? Math.min(configuredAvatarBytes, maximumAvatarBytes)
    : maximumAvatarBytes;
  const avatarProcessor = createAvatarProcessor({ maximumBytes: avatarUploadMaxBytes });
  const configuredAttachmentBytes = Number.parseInt(
    process.env.FORUM_ATTACHMENT_MAX_BYTES ?? String(maximumAttachmentBytes),
    10,
  );
  const attachmentUploadMaxBytes = Number.isSafeInteger(configuredAttachmentBytes)
    && configuredAttachmentBytes > 0
    ? Math.min(configuredAttachmentBytes, maximumAttachmentBytes)
    : maximumAttachmentBytes;
  const configuredAttachmentQuotaBytes = Number.parseInt(
    process.env.FORUM_ATTACHMENT_ACCOUNT_QUOTA_BYTES
      ?? String(defaultAttachmentAccountQuotaBytes),
    10,
  );
  if (
    !Number.isSafeInteger(configuredAttachmentQuotaBytes)
    || configuredAttachmentQuotaBytes < maximumAttachmentBytes
    || configuredAttachmentQuotaBytes > 10 * 1024 * 1024 * 1024
  ) {
    throw new Error('FORUM_ATTACHMENT_ACCOUNT_QUOTA_BYTES must be between 10485760 and 10737418240');
  }
  const attachmentProcessor = createAttachmentProcessor({ maximumBytes: attachmentUploadMaxBytes });
  const sessionIdleTimeoutMs = Number.parseInt(
    process.env.SESSION_IDLE_TIMEOUT_MS ?? String(7 * 24 * 60 * 60 * 1000),
    10,
  );
  if (
    !Number.isSafeInteger(sessionIdleTimeoutMs)
    || sessionIdleTimeoutMs < 15 * 60 * 1000
    || sessionIdleTimeoutMs > 30 * 24 * 60 * 60 * 1000
  ) {
    throw new Error('SESSION_IDLE_TIMEOUT_MS must be between 900000 and 2592000000');
  }
  const passwordHasher = createPasswordHasher();
  const dummyPasswordHash = await passwordHasher.hash('not a user password');
  const pool = createDatabasePool(databaseUrl);
  await assertMigrationsCurrent(pool);
  const readinessCheck = createDatabaseReadinessCheck(pool);
  const repository = createRepository(pool, { dummyPasswordHash });
  const webPushConfiguration = loadWebPushConfiguration();
  const mailer = createMailer({
    from: process.env.MAIL_FROM ?? 'roriwalrus <noreply@localhost>',
    mode: process.env.MAIL_TRANSPORT
      ?? (process.env.NODE_ENV === 'production' ? undefined : 'console'),
    production: process.env.NODE_ENV === 'production',
    smtpHost: process.env.SMTP_HOST,
    smtpPassword: process.env.SMTP_PASSWORD,
    smtpPort: Number.parseInt(process.env.SMTP_PORT ?? '587', 10),
    smtpRequireTls: process.env.SMTP_REQUIRE_TLS !== 'false',
    smtpSecure: process.env.SMTP_SECURE === 'true',
    smtpUser: process.env.SMTP_USER,
  });
  const authService = createAuthService({
    avatarProcessor,
    mailer,
    passwordHasher,
    publicOrigin,
    repository,
    sessionIdleTimeoutMs,
  });
  const configuredWebPushService = createWebPushService({
    authService,
    configuration: webPushConfiguration,
    repository: createWebPushRepository(pool),
  });
  const forumRepository = createForumRepository(pool);
  const profilePostRepository = createProfilePostRepository(pool);
  const directMessageRepository = createDirectMessageRepository(pool);
  const directMessageService = createDirectMessageService({
    authService,
    repository: directMessageRepository,
  });
  const forumRestartMarkerPath = process.env.FORUM_RESTART_MARKER_PATH;
  if (forumRestartMarkerPath) {
    await validateForumRestartMarker(forumRestartMarkerPath);
  }
  const forumRestart = forumRestartMarkerPath
    ? createForumRestart({ markerPath: forumRestartMarkerPath })
    : null;
  const administrationService = createAdministrationService({
    authService,
    forumRestart,
    forumRepository,
    repository,
  });
  const forumService = createForumService({
    attachmentAccountQuotaBytes: configuredAttachmentQuotaBytes,
    attachmentProcessor,
    authService,
    repository: forumRepository,
  });
  const profileService = createProfileService({
    authService,
    forumRepository,
    profilePostRepository,
    repository,
  });
  const shoutReactionService = createShoutReactionService({ authService, repository });
  const shoutboxService = createShoutboxService({ authService, repository });
  const presenceService = createPresenceService({
    secret: process.env.PRESENCE_CHALLENGE_SECRET || undefined,
  });
  const requestLimiter = createFixedWindowLimiter();
  const trustedProxyAddresses = createTrustedProxyAddresses(
    process.env.TRUSTED_PROXY_ADDRESSES,
    process.env.TRUST_PROXY === 'true',
  );
  const server = createForumServer({
    administrationService,
    attachmentUploadMaxBytes,
    authService,
    avatarUploadMaxBytes,
    directMessageService,
    forumService,
    logger,
    presenceService,
    profileService,
    publicOrigin,
    readinessCheck,
    requestLimiter,
    shoutReactionService,
    shoutboxService,
    trustedProxyAddresses,
    webPushService: configuredWebPushService,
  });
  const cookieNames = getCookieNames(publicOrigin.startsWith('https://'));
  attachShoutbox({
    authService,
    getSiteAccessPolicy: () => administrationService.getSiteAccessPolicy(),
    publicOrigin,
    readSessionToken: (request) => readCookies(request)[cookieNames.session],
    repository,
    requestLimiter,
    server,
    trustedProxyAddresses,
  });

  server.listen(port, host, () => {
    logger.serviceStarted();
  });
  const close = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  const logger = createJsonLogger();
  startServer({ logger }).catch((error) => {
    logger.serviceStartFailed(error);
    process.exit(1);
  });
}