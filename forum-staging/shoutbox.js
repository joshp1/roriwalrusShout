import { WebSocket, WebSocketServer } from 'ws';
import { stripHtmlTags } from './authored-text.js';
import { normalizeDatabaseId } from './database-id.js';
import { getClientAddress } from './request-limits.js';
import { extractMarkdownMentionUsernames, MentionError } from './mentions.js';
import { canViewAccount, hasPermission, isAdministrator, permissions } from './policy.js';
import { isValidShoutReaction } from './shout-reaction.js';
import { parseIsoTimestamp } from './timestamp.js';
import { isCanonicalUuid } from './uuid.js';

const maximumShoutCursor = 9_223_372_036_854_775_807n;
const maximumFlagPageSize = 50;
const shoutHistoryPageSize = 50;
export const maximumShoutboxBufferedBytes = 256 * 1024;

export class ShoutboxError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseShoutboxStream(value) {
  if (value === null || value === 'public') {
    return 'public';
  }
  return value === 'staff' ? value : undefined;
}

function canAccessShoutboxStream(account, streamKey) {
  return streamKey === 'public' || hasPermission(account, permissions.shoutsModerate);
}

function parseFlagPageValue(value, fallback, maximum, allowZero = true) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new ShoutboxError('invalid_shout_flag_query', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum || (!allowZero && parsed === 0)) {
    throw new ShoutboxError('invalid_shout_flag_query', 400);
  }
  return parsed;
}

function validateFlagReason(value) {
  const reason = typeof value === 'string' ? stripHtmlTags(value).trim() : '';
  const reasonLength = Array.from(reason).length;
  if (reasonLength < 3 || reasonLength > 500) {
    throw new ShoutboxError('invalid_shout_flag_reason', 400);
  }
  return reason;
}

function hasExactKeys(input, expectedKeys) {
  return input
    && typeof input === 'object'
    && !Array.isArray(input)
    && Object.keys(input).sort().join(',') === expectedKeys.join(',');
}

export function createShoutboxService({ authService, repository }) {
  return Object.freeze({
    async createFlag(sessionToken, csrfToken, shoutId, input) {
      const session = await authService.getSession(sessionToken);
      await authService.requireCsrf(session, csrfToken);
      if (!hasExactKeys(input, ['reason', 'stream'])) {
        throw new ShoutboxError('invalid_shout_flag', 400);
      }
      const id = normalizeDatabaseId(shoutId);
      const streamKey = parseShoutboxStream(input.stream);
      if (!id || !streamKey || !canAccessShoutboxStream(session.account, streamKey)) {
        throw new ShoutboxError('shout_unavailable', 404);
      }
      const result = await repository.createShoutFlag({
        actorId: session.account.id,
        reason: validateFlagReason(input.reason),
        shoutId: id,
        streamKey,
      });
      if (!result) {
        throw new ShoutboxError('shout_unavailable', 404);
      }
      if (result.duplicate) {
        throw new ShoutboxError('shout_already_flagged', 409);
      }
      return result.flag;
    },
    async decideFlag(sessionToken, csrfToken, flagId, input) {
      const session = await authService.getSession(sessionToken);
      if (!hasPermission(session.account, permissions.shoutsModerate)) {
        throw new ShoutboxError('shout_flag_unavailable', 404);
      }
      await authService.requireCsrf(session, csrfToken);
      if (!hasExactKeys(input, ['decision', 'expectedUpdatedAt', 'reason'])) {
        throw new ShoutboxError('invalid_shout_flag_decision', 400);
      }
      const id = normalizeDatabaseId(flagId);
      const expectedUpdatedAt = parseIsoTimestamp(input.expectedUpdatedAt);
      if (!id || !expectedUpdatedAt || !['dismissed', 'resolved'].includes(input.decision)) {
        throw new ShoutboxError('invalid_shout_flag_decision', 400);
      }
      const result = await repository.decideShoutFlag({
        actorId: session.account.id,
        decision: input.decision,
        expectedUpdatedAt,
        flagId: id,
        reason: validateFlagReason(input.reason),
      });
      if (!result || result.permissionDenied) {
        throw new ShoutboxError('shout_flag_unavailable', 404);
      }
      if (result.conflict) {
        throw new ShoutboxError('shout_flag_conflict', 409);
      }
      return result.flag;
    },
    async listFlags(sessionToken, shoutId, query = {}) {
      const session = await authService.getSession(sessionToken);
      if (!hasPermission(session.account, permissions.shoutsModerate)) {
        throw new ShoutboxError('shout_unavailable', 404);
      }
      const id = normalizeDatabaseId(shoutId);
      const streamKey = parseShoutboxStream(query.stream ?? null);
      if (!id || !streamKey || !canAccessShoutboxStream(session.account, streamKey)) {
        throw new ShoutboxError('shout_unavailable', 404);
      }
      const limit = parseFlagPageValue(query.limit, 20, maximumFlagPageSize, false);
      const offset = parseFlagPageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
      const flags = await repository.listShoutFlags(
        session.account.id,
        id,
        limit + 1,
        offset,
        streamKey,
      );
      if (flags === null) {
        throw new ShoutboxError('shout_unavailable', 404);
      }
      return {
        flags: flags.slice(0, limit),
        hasMore: flags.length > limit,
        nextOffset: offset + Math.min(flags.length, limit),
      };
    },
    async locateShout(sessionToken, shoutId, query = {}) {
      const { account } = await authService.getSession(sessionToken);
      const id = normalizeDatabaseId(shoutId);
      const streamKey = parseShoutboxStream(query.stream ?? null);
      if (!id || !streamKey) {
        throw new ShoutboxError('invalid_shout', 400);
      }
      const location = await repository.locateRetainedShout(account.id, id, streamKey);
      if (!location) {
        throw new ShoutboxError('shout_unavailable', 404);
      }
      return location;
    },
  });
}

function parseShoutCursor(value) {
  if (value === null) {
    return null;
  }
  if (!/^(0|[1-9]\d{0,18})$/.test(value)) {
    return undefined;
  }
  return BigInt(value) <= maximumShoutCursor ? value : undefined;
}

function isCursorAfter(candidate, cursor) {
  const parsedCandidate = parseShoutCursor(candidate);
  return parsedCandidate !== undefined
    && parsedCandidate !== null
    && BigInt(parsedCandidate) > BigInt(cursor);
}

function parseShoutHistoryBefore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const createdAt = parseIsoTimestamp(value.createdAt);
  const id = normalizeDatabaseId(value.id);
  return createdAt && id ? { createdAt, id } : null;
}

export function isShoutVisibleToAccount(shoutCreatedAt, accountCreatedAt) {
  const shoutTimestamp = new Date(shoutCreatedAt).getTime();
  const accountTimestamp = new Date(accountCreatedAt).getTime();
  return Number.isFinite(shoutTimestamp)
    && Number.isFinite(accountTimestamp)
    && shoutTimestamp >= accountTimestamp;
}

export function isShoutboxBackpressured(webSocket, maximumBufferedBytes, nextFrameBytes = 0) {
  return webSocket.bufferedAmount + nextFrameBytes > maximumBufferedBytes;
}

function rejectUpgrade(socket, statusCode, message, headers = {}) {
  const headerLines = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n${headerLines}\r\n`,
  );
  socket.destroy();
}

export function attachShoutbox({
  authService,
  clearTimer = clearTimeout,
  clock = () => Date.now(),
  connectionLimit = { limit: 20, windowMs: 60_000 },
  getSiteAccessPolicy,
  maximumCatchUpChanges = 50,
  maximumBufferedBytes = maximumShoutboxBufferedBytes,
  maximumPendingDeliveries = 50,
  messageLimit = { limit: 60, windowMs: 60_000 },
  publicOrigin,
  readSessionToken,
  repository,
  requestLimiter,
  server,
  setTimer = setTimeout,
  trustedProxyAddresses = new Set(),
}) {
  const socketServer = new WebSocketServer({ maxPayload: 4096, noServer: true });
  const connectionStates = new Map();

  async function isSiteAccessBlocked(account) {
    if (isAdministrator(account) || typeof getSiteAccessPolicy !== 'function') {
      return false;
    }
    return (await getSiteAccessPolicy())?.blocked === true;
  }

  function removeConnection(webSocket) {
    const state = connectionStates.get(webSocket);
    if (state?.timer) {
      clearTimer(state.timer);
    }
    connectionStates.delete(webSocket);
  }

  function closeConnection(webSocket, code, reason) {
    removeConnection(webSocket);
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.close(code, reason);
    }
  }

  function sendPayload(webSocket, payload) {
    const encoded = JSON.stringify(payload);
    if (
      webSocket.readyState !== WebSocket.OPEN
      || isShoutboxBackpressured(webSocket, maximumBufferedBytes, Buffer.byteLength(encoded))
    ) {
      closeConnection(webSocket, 1013, 'Transport buffer exceeded');
      return false;
    }
    webSocket.send(encoded);
    return true;
  }

  async function drainDeliveries(webSocket) {
    const state = connectionStates.get(webSocket);
    if (
      !state
      || !state.ready
      || state.draining
      || state.timer
      || state.pending.length === 0
      || webSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    state.draining = true;
    try {
      const session = await authService.getSession(state.sessionToken);
      if (await isSiteAccessBlocked(session.account)) {
        closeConnection(webSocket, 1013, 'Site access blocked');
        return;
      }
      if (!canAccessShoutboxStream(session.account, state.streamKey)) {
        closeConnection(webSocket, 1008, 'Shoutbox stream unavailable');
        return;
      }
      state.accountRole = session.account.role;
      const slowdownMs = isAdministrator(session.account) || session.account.role === 'moderator'
        ? 0
        : session.account.slowdownMs ?? 0;
      const waitMs = Math.max(0, state.lastDeliveredAt + slowdownMs - clock());
      if (waitMs > 0) {
        state.timer = setTimer(() => {
          state.timer = null;
          void drainDeliveries(webSocket);
        }, waitMs);
        return;
      }

      const payload = state.pending.shift();
      if (!sendPayload(webSocket, payload)) {
        return;
      }
      state.lastDeliveredAt = clock();
    } catch {
      closeConnection(webSocket, 1008, 'Account unavailable');
    } finally {
      state.draining = false;
    }

    if (state.pending.length > 0 && !state.timer) {
      void drainDeliveries(webSocket);
    }
  }

  function enqueueDelivery(webSocket, payload) {
    const state = connectionStates.get(webSocket);
    if (!state) {
      return;
    }
    if (state.pending.length >= maximumPendingDeliveries) {
      closeConnection(webSocket, 1013, 'Update queue exceeded');
      return;
    }
    state.pending.push(payload);
    void drainDeliveries(webSocket);
  }

  function broadcast(
    payload,
    shoutCreatedAt,
    visibleToRole,
    streamKey = 'public',
    { ignoreAccountAge = false } = {},
  ) {
    for (const [client, state] of connectionStates) {
      if (
        client.readyState === WebSocket.OPEN
        && state.streamKey === streamKey
        && (ignoreAccountAge || isShoutVisibleToAccount(shoutCreatedAt, state.accountCreatedAt))
        && canViewAccount({ role: state.accountRole }, { visibleToRole })
      ) {
        enqueueDelivery(client, payload);
      }
    }
  }

  function broadcastReaction(shout, actorId) {
    const streamKey = shout.streamKey ?? 'public';
    for (const [client, state] of connectionStates) {
      if (
        client.readyState === WebSocket.OPEN
        && state.streamKey === streamKey
        && (shout.pinnedAt || isShoutVisibleToAccount(shout.createdAt, state.accountCreatedAt))
        && canViewAccount({ role: state.accountRole }, shout)
        && canViewAccount(
          { role: state.accountRole },
          { visibleToRole: shout.reactionVisibleToRole },
        )
      ) {
        enqueueDelivery(client, {
          cursor: shout.syncCursor,
          id: shout.id,
          reactions: shout.reactions,
          type: 'shout_reaction',
          viewerReaction: state.accountId === actorId ? shout.viewerReaction : undefined,
          viewerReactions: state.accountId === actorId ? shout.viewerReactions : undefined,
        });
      }
    }
  }

  async function loadReadyPayload(cursor, viewerId, streamKey) {
    if (cursor !== null) {
      const currentCursor = await repository.getShoutboxCursor(streamKey, viewerId);
      if (BigInt(cursor) > BigInt(currentCursor)) {
        const snapshot = await repository.getShoutboxSnapshot(50, viewerId, streamKey);
        return { ...snapshot, reset: true, streamKey, type: 'ready' };
      }
      const changes = await repository.listShoutChanges(
        cursor,
        maximumCatchUpChanges + 1,
        viewerId,
        streamKey,
      );
      if (changes.length <= maximumCatchUpChanges) {
        return {
          changes,
          cursor: currentCursor,
          reset: false,
          streamKey,
          type: 'ready',
        };
      }
    }

    const snapshot = await repository.getShoutboxSnapshot(50, viewerId, streamKey);
    return { ...snapshot, reset: true, streamKey, type: 'ready' };
  }

  server.on('upgrade', async (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (requestUrl.pathname !== '/shoutbox') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const cursor = parseShoutCursor(requestUrl.searchParams.get('cursor'));
    const streamKey = parseShoutboxStream(requestUrl.searchParams.get('stream'));
    if (cursor === undefined || streamKey === undefined) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (publicOrigin && request.headers.origin !== publicOrigin) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const address = getClientAddress(request, trustedProxyAddresses);
    const sessionToken = readSessionToken(request);
    try {
      const session = await authService.getSession(sessionToken);
      if (await isSiteAccessBlocked(session.account)) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      if (!canAccessShoutboxStream(session.account, streamKey)) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      if (requestLimiter && !isAdministrator(session.account) && session.account.role !== 'moderator') {
        const admission = requestLimiter.consume(
          `shoutbox_connection:${address}`,
          connectionLimit,
        );
        if (!admission.allowed) {
          rejectUpgrade(socket, 429, 'Too Many Requests', {
            'Retry-After': String(Math.ceil(admission.retryAfterMs / 1000)),
          });
          return;
        }
      }
      if (!session.account.preferences.shoutboxEnabled) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      socketServer.handleUpgrade(request, socket, head, (webSocket) => {
        socketServer.emit('connection', webSocket, request, {
          accountCreatedAt: session.account.createdAt ?? new Date(0),
          accountId: session.account.id,
          accountRole: session.account.role,
          address,
          cursor,
          sessionToken,
          streamKey,
        });
      });
    } catch {
      rejectUpgrade(socket, 401, 'Unauthorized');
    }
  });

  socketServer.on('connection', async (
    webSocket,
    _request,
    { accountCreatedAt, accountId, accountRole, address, cursor, sessionToken, streamKey },
  ) => {
    const state = {
      accountCreatedAt,
      accountId,
      accountRole,
      address,
      draining: false,
      lastDeliveredAt: clock(),
      pending: [],
      ready: false,
      sessionToken,
      streamKey,
      timer: null,
    };
    connectionStates.set(webSocket, state);
    webSocket.once('close', () => removeConnection(webSocket));
    webSocket.on('error', () => removeConnection(webSocket));
    try {
      const readyPayload = await loadReadyPayload(cursor, accountId, streamKey);
      if (!sendPayload(webSocket, readyPayload)) {
        return;
      }
      state.pending = state.pending.filter((payload) => (
        !payload.cursor || isCursorAfter(payload.cursor, readyPayload.cursor)
      ));
      state.ready = true;
      void drainDeliveries(webSocket);
    } catch {
      removeConnection(webSocket);
      webSocket.close(1011, 'Shoutbox unavailable');
      return;
    }

    webSocket.on('message', async (rawMessage, isBinary) => {
      try {
        const session = await authService.getSession(sessionToken);
        if (await isSiteAccessBlocked(session.account)) {
          closeConnection(webSocket, 1013, 'Site access blocked');
          return;
        }
        if (!canAccessShoutboxStream(session.account, streamKey)) {
          closeConnection(webSocket, 1008, 'Shoutbox stream unavailable');
          return;
        }
        if (requestLimiter && !isAdministrator(session.account) && session.account.role !== 'moderator') {
          const admission = requestLimiter.consume(`shoutbox_message:${state.address}`, messageLimit);
          if (!admission.allowed) {
            sendPayload(webSocket, {
              code: 'shoutbox_rate_limited',
              retryAfterMs: admission.retryAfterMs,
              type: 'error',
            });
            return;
          }
        }
        if (isBinary) {
          sendPayload(webSocket, { code: 'invalid_message', type: 'error' });
          return;
        }
        const message = JSON.parse(rawMessage.toString());
        if (!['delete', 'edit', 'history', 'pin', 'reaction', 'shout'].includes(message.type)) {
          sendPayload(webSocket, { code: 'invalid_shout', type: 'error' });
          return;
        }
        if (!session.account.preferences.shoutboxEnabled) {
          webSocket.close(1008, 'Shoutbox disabled');
          return;
        }

        const body = typeof message.body === 'string'
          ? stripHtmlTags(message.body).replace(/\r\n?/g, '\n').trim()
          : '';
        const clientMutationId = isCanonicalUuid(message.clientMutationId)
          ? message.clientMutationId
          : undefined;
        const reason = typeof message.reason === 'string' ? stripHtmlTags(message.reason).trim() : '';
        const shoutId = normalizeDatabaseId(message.id);
        const canModerate = hasPermission(session.account, permissions.shoutsModerate);
        if (message.type === 'history') {
          const before = parseShoutHistoryBefore(message.before);
          if (!before) {
            sendPayload(webSocket, { code: 'invalid_history', type: 'error' });
            return;
          }
          let page;
          try {
            page = await repository.getShoutboxHistoryPage(
              before,
              shoutHistoryPageSize,
              session.account.id,
              streamKey,
            );
          } catch {
            sendPayload(webSocket, { code: 'history_unavailable', type: 'error' });
            return;
          }
          sendPayload(webSocket, { ...page, type: 'shout_history' });
          return;
        }
        if (message.type === 'delete') {
          if (!shoutId) {
            sendPayload(webSocket, { code: 'invalid_shout', type: 'error' });
            return;
          }
          const result = await repository.deleteShout(
            session.account.id,
            shoutId,
            canModerate,
            reason,
            streamKey,
          );
          if (!result || result.reasonRequired) {
            sendPayload(webSocket, {
              code: result?.reasonRequired ? 'moderation_reason_required' : 'shout_unavailable',
              type: 'error',
            });
            return;
          }
          broadcast(
            { cursor: result.cursor, id: result.id, type: 'shout_deleted' },
            result.createdAt,
            result.visibleToRole,
            result.streamKey,
            { ignoreAccountAge: result.wasPinned },
          );
          return;
        }

        if (message.type === 'reaction') {
          if (!shoutId || !isValidShoutReaction(message.reaction)) {
            sendPayload(webSocket, { code: 'invalid_reaction', type: 'error' });
            return;
          }
          const result = await repository.toggleShoutReaction(
            session.account.id,
            shoutId,
            message.reaction,
            streamKey,
          );
          if (!result) {
            sendPayload(webSocket, { code: 'shout_unavailable', type: 'error' });
            return;
          }
          broadcastReaction(result, session.account.id);
          return;
        }

        if (message.type === 'pin') {
          if (!shoutId || typeof message.pinned !== 'boolean' || !canModerate) {
            sendPayload(webSocket, { code: 'shout_unavailable', type: 'error' });
            return;
          }
          const result = await repository.setShoutPinned(
            session.account.id,
            shoutId,
            message.pinned,
            streamKey,
          );
          if (!result || result.limitReached) {
            sendPayload(webSocket, {
              code: result?.limitReached ? 'shout_pin_limit' : 'shout_unavailable',
              type: 'error',
            });
            return;
          }
          if (!result.unchanged) {
            broadcast(
              message.pinned ? {
                cursor: result.shout.syncCursor,
                shout: result.shout,
                type: 'shout_pinned',
              } : {
                cursor: result.shout.syncCursor,
                type: 'shout_reset',
              },
              result.shout.createdAt,
              result.shout.visibleToRole,
              result.shout.streamKey,
              { ignoreAccountAge: true },
            );
          }
          return;
        }

        if (
          body.length === 0
          || body.length > 500
          || body.split('\n').length > 4
          || (message.type === 'edit' && !shoutId)
        ) {
          sendPayload(webSocket, { code: 'invalid_shout', type: 'error' });
          return;
        }
        await authService.requireShoutboxPostingAllowed(session.account);
        if (message.type === 'edit') {
          const result = await repository.updateShout(
            session.account.id,
            shoutId,
            body,
            extractMarkdownMentionUsernames(body),
            canModerate,
            reason,
            streamKey,
          );
          if (!result || result.reasonRequired) {
            sendPayload(webSocket, {
              code: result?.reasonRequired ? 'moderation_reason_required' : 'shout_unavailable',
              type: 'error',
            });
            return;
          }
          broadcast(
            { cursor: result.syncCursor, shout: result, type: 'shout_updated' },
            result.createdAt,
            result.visibleToRole,
            result.streamKey,
            { ignoreAccountAge: Boolean(result.pinnedAt) },
          );
          return;
        }

        const shout = await repository.createShout(
          session.account.id,
          body,
          extractMarkdownMentionUsernames(body),
          streamKey,
        );
        broadcast(
          { clientMutationId, cursor: shout.syncCursor, shout, type: 'shout' },
          shout.createdAt,
          shout.visibleToRole,
          shout.streamKey,
        );
      } catch (error) {
        const postingLimited = [
          'posting_flood_detected',
          'posting_rate_limited',
          'posting_slowdown',
        ].includes(error?.code);
        const postingMuted = error?.code === 'shoutbox_posting_muted';
        const invalidMention = error instanceof MentionError;
        sendPayload(webSocket, {
          code: postingLimited || postingMuted || invalidMention ? error.code : 'invalid_message',
          retryAfterMs: postingLimited ? error.retryAfterMs : undefined,
          type: 'error',
        });
      }
    });
  });

  server.on('close', () => {
    for (const webSocket of connectionStates.keys()) {
      removeConnection(webSocket);
    }
    socketServer.close();
  });
  return socketServer;
}