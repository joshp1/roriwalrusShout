import { normalizeDatabaseId } from './database-id.js';
import { extractMarkdownMentionUsernames } from './mentions.js';
import { parseIsoTimestamp } from './timestamp.js';
import { isValidUsername, normalizeUsername } from './username.js';
import { stripHtmlTags } from './authored-text.js';

const maximumPageSize = 50;
const editWindowMs = 30 * 60 * 1000;

export class DirectMessageError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function boundedText(value, minimum, maximum, code) {
  const text = typeof value === 'string' ? stripHtmlTags(value).trim() : '';
  if (text.length < minimum || text.length > maximum) {
    throw new DirectMessageError(code, 400);
  }
  return text;
}

function parseId(value) {
  const id = normalizeDatabaseId(value);
  if (!id) {
    throw new DirectMessageError('invalid_direct_message', 400);
  }
  return id;
}

function parsePageValue(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value)) {
    throw new DirectMessageError('invalid_direct_message_query', 400);
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new DirectMessageError('invalid_direct_message_query', 400);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new DirectMessageError('invalid_direct_message_query', 400);
  }
  return parsed;
}

function parsePageLimit(value, fallback) {
  const limit = parsePageValue(value, fallback, maximumPageSize);
  if (limit === 0) {
    throw new DirectMessageError('invalid_direct_message_query', 400);
  }
  return limit;
}

function parseMessageMode(value) {
  if (value === undefined || value === null) {
    return 'post';
  }
  if (!['post', 'chat'].includes(value)) {
    throw new DirectMessageError('invalid_direct_message_query', 400);
  }
  return value;
}

function normalizedUsername(value) {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!isValidUsername(username)) {
    throw new DirectMessageError('invalid_direct_message_participant', 400);
  }
  return normalizeUsername(username);
}

function parseExpectedUpdatedAt(value) {
  const expectedUpdatedAt = parseIsoTimestamp(value);
  if (!expectedUpdatedAt) {
    throw new DirectMessageError('invalid_direct_message_version', 400);
  }
  return expectedUpdatedAt;
}

export function createDirectMessageService({ authService, clock = () => new Date(), repository }) {
  async function requireMutation(sessionToken, csrfToken) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    return session;
  }

  async function createThread(sessionToken, csrfToken, input) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const title = boundedText(input.title, 3, 120, 'invalid_direct_message_title');
    if (!Array.isArray(input.usernames) || input.usernames.length === 0 || input.usernames.length > 20) {
      throw new DirectMessageError('invalid_direct_message_participants', 400);
    }
    const usernames = [...new Set(input.usernames.map(normalizedUsername))];
    const thread = await repository.createThread(account.id, title, usernames);
    if (!thread) {
      throw new DirectMessageError('invalid_direct_message_participants', 400);
    }
    return thread;
  }

  async function listThreads(sessionToken, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    const limit = parsePageLimit(query.limit, 20);
    const offset = parsePageValue(query.offset, 0);
    const threads = await repository.listThreads(account.id, limit + 1, offset);
    return {
      hasMore: threads.length > limit,
      nextOffset: offset + Math.min(threads.length, limit),
      threads: threads.slice(0, limit),
      unreadCount: await repository.countUnreadMessages(account.id),
    };
  }

  async function getThread(sessionToken, threadId, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    const limit = parsePageLimit(query.limit, 50);
    const mode = parseMessageMode(query.mode);
    const offset = parsePageValue(query.offset, 0);
    const result = await repository.getThread(
      account.id,
      parseId(threadId),
      limit + 1,
      offset,
      mode,
    );
    if (!result) {
      throw new DirectMessageError('direct_message_not_found', 404);
    }
    return {
      ...result,
      hasMore: result.messages.length > limit,
      messages: result.messages.slice(0, limit).reverse(),
      nextOffset: offset + Math.min(result.messages.length, limit),
    };
  }

  async function locateMessage(sessionToken, threadId, messageId, query = {}) {
    const { account } = await authService.getSession(sessionToken);
    const location = await repository.locateMessage(
      account.id,
      parseId(threadId),
      parseId(messageId),
      parseMessageMode(query.mode),
    );
    if (!location) {
      throw new DirectMessageError('direct_message_not_found', 404);
    }
    return location;
  }

  async function createMessage(sessionToken, csrfToken, threadId, input) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const body = boundedText(input.body, 1, 10_000, 'invalid_direct_message_body');
    const mode = parseMessageMode(input.mode);
    await authService.requirePostingAllowed(account);
    const message = await repository.createMessage(
      account.id,
      parseId(threadId),
      body,
      extractMarkdownMentionUsernames(body),
      mode,
    );
    if (!message) {
      throw new DirectMessageError('direct_message_unavailable', 409);
    }
    return message;
  }

  async function deleteMessage(sessionToken, csrfToken, messageId, query = {}) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const deletedAt = clock();
    const result = await repository.deleteMessage({
      actorId: account.id,
      deletedAt,
      messageId: parseId(messageId),
      mode: parseMessageMode(query.mode),
      ownerEditCutoff: new Date(deletedAt.getTime() - editWindowMs),
    });
    if (result.status === 'not_found') {
      throw new DirectMessageError('direct_message_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new DirectMessageError('direct_message_delete_denied', 403);
    }
    return result.message;
  }

  async function editMessage(sessionToken, csrfToken, messageId, input) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const body = boundedText(input.body, 1, 10_000, 'invalid_direct_message_body');
    const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
    const mode = parseMessageMode(input.mode);
    await authService.requirePostingAllowed(account);
    const updatedAt = clock();
    const result = await repository.editMessage({
      actorId: account.id,
      body,
      expectedUpdatedAt,
      mentions: extractMarkdownMentionUsernames(body),
      messageId: parseId(messageId),
      mode,
      ownerEditCutoff: new Date(updatedAt.getTime() - editWindowMs),
      updatedAt,
    });
    if (result.status === 'not_found') {
      throw new DirectMessageError('direct_message_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new DirectMessageError('direct_message_edit_denied', 403);
    }
    if (result.status === 'conflict') {
      throw new DirectMessageError('direct_message_edit_conflict', 409);
    }
    return result.message;
  }

  async function inviteMember(sessionToken, csrfToken, threadId, input) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const thread = await repository.inviteMember(
      account.id,
      parseId(threadId),
      normalizedUsername(input.username),
    );
    if (!thread) {
      throw new DirectMessageError('direct_message_unavailable', 409);
    }
    return thread;
  }

  async function leaveThread(sessionToken, csrfToken, threadId) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const result = await repository.leaveThread(account.id, parseId(threadId));
    if (!result) {
      throw new DirectMessageError('direct_message_unavailable', 409);
    }
    return result;
  }

  async function lockThread(sessionToken, csrfToken, threadId) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const thread = await repository.lockThread(account.id, parseId(threadId));
    if (!thread) {
      throw new DirectMessageError('direct_message_unavailable', 409);
    }
    return thread;
  }

  async function markThreadRead(sessionToken, csrfToken, threadId, query = {}) {
    const { account } = await requireMutation(sessionToken, csrfToken);
    const throughMessageId = query.through === undefined || query.through === null
      ? null
      : parseId(query.through);
    const result = await repository.markThreadRead(
      account.id,
      parseId(threadId),
      parseMessageMode(query.mode),
      throughMessageId,
    );
    if (!result) {
      throw new DirectMessageError('direct_message_not_found', 404);
    }
    return result;
  }

  return {
    createMessage,
    createThread,
    deleteMessage,
    editMessage,
    getThread,
    locateMessage,
    inviteMember,
    leaveThread,
    listThreads,
    lockThread,
    markThreadRead,
  };
}