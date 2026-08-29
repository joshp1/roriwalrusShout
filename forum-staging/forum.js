import { hasPermission, permissions, requirePermission } from './policy.js';
import { extractMarkdownMentionUsernames } from './mentions.js';
import { normalizeDatabaseId } from './database-id.js';
import { isValidReaction } from './reaction.js';
import { parseIsoTimestamp } from './timestamp.js';
import { stripHtmlTags } from './authored-text.js';
import {
  defaultAttachmentAccountQuotaBytes,
  maximumAttachmentsPerPost,
} from './attachment.js';

const editWindowMs = 30 * 60 * 1000;
const maximumPageSize = 50;
const subforumKeys = new Set(['moderation', 'public']);

export class ForumError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseId(value, code) {
  const id = normalizeDatabaseId(value);
  if (!id) {
    throw new ForumError(code, 400);
  }
  return id;
}

function parsePageValue(value, fallback, maximum) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new ForumError('invalid_forum_query', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ForumError('invalid_forum_query', 400);
  }
  return parsed;
}

function parsePageLimit(value, fallback) {
  const limit = parsePageValue(value, fallback, maximumPageSize);
  if (limit === 0) {
    throw new ForumError('invalid_forum_query', 400);
  }
  return limit;
}

function parseSubforumKey(value) {
  const subforumKey = value === undefined || value === null ? 'public' : value;
  if (typeof subforumKey !== 'string' || !subforumKeys.has(subforumKey)) {
    throw new ForumError('invalid_subforum', 400);
  }
  return subforumKey;
}

function requireSubforumAccess(account, subforumKey) {
  if (subforumKey === 'moderation' && !hasPermission(account, permissions.postsModerate)) {
    throw new ForumError('subforum_not_found', 404);
  }
}

function boundedText(value, minimum, maximum, code, authored = true) {
  const source = typeof value === 'string' ? value : '';
  const text = (authored ? stripHtmlTags(source) : source).trim();
  if (text.length < minimum || text.length > maximum) {
    throw new ForumError(code, 400);
  }
  return text;
}

function parseExpectedUpdatedAt(value, code) {
  const expectedUpdatedAt = parseIsoTimestamp(value);
  if (!expectedUpdatedAt) {
    throw new ForumError(code, 400);
  }
  return expectedUpdatedAt;
}

function parseAttachmentName(value) {
  const name = typeof value === 'string'
    ? value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim()
    : '';
  if (!name || name.length > 180) {
    throw new ForumError('invalid_attachment_name', 400);
  }
  return name;
}

export function createForumService({
  attachmentAccountQuotaBytes = defaultAttachmentAccountQuotaBytes,
  attachmentProcessor,
  authService,
  clock = () => new Date(),
  repository,
}) {
  async function requireMutation(sessionToken, csrfToken) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    return session.account;
  }

  async function listTopics(sessionToken, query = {}) {
    const session = await authService.getSession(sessionToken);
    const subforumKey = parseSubforumKey(query.subforum);
    requireSubforumAccess(session.account, subforumKey);
    const limit = parsePageLimit(query.limit, 20);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const topics = await repository.listTopics(
      session.account.id,
      subforumKey,
      limit + 1,
      offset,
    );
    return {
      hasMore: topics.length > limit,
      nextOffset: offset + Math.min(topics.length, limit),
      subforumKey,
      topics: topics.slice(0, limit),
    };
  }

  async function searchContent(sessionToken, query = {}) {
    const session = await authService.getSession(sessionToken);
    const searchQuery = boundedText(query.q, 2, 200, 'invalid_search_query', false);
    const limit = parsePageLimit(query.limit, 20);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const results = await repository.searchContent(
      session.account.id,
      searchQuery,
      limit + 1,
      offset,
    );
    return {
      hasMore: results.length > limit,
      nextOffset: offset + Math.min(results.length, limit),
      results: results.slice(0, limit),
    };
  }

  async function inspectDeletedPost(sessionToken, postId, query = {}) {
    const session = await authService.getSession(sessionToken);
    requirePermission(session.account, permissions.postsModerate);
    const id = parseId(postId, 'invalid_post');
    const limit = parsePageLimit(query.limit, 20);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const result = await repository.inspectDeletedPost(
      session.account.id,
      id,
      limit + 1,
      offset,
    );
    if (!result) {
      throw new ForumError('post_not_found', 404);
    }
    return {
      hasMore: result.revisions.length > limit,
      nextOffset: offset + Math.min(result.revisions.length, limit),
      post: result.post,
      revisions: result.revisions.slice(0, limit),
    };
  }

  async function getTopic(sessionToken, topicId, query = {}) {
    const session = await authService.getSession(sessionToken);
    const id = parseId(topicId, 'invalid_topic');
    const limit = parsePageLimit(query.limit, 30);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const result = await repository.getTopic(id, session.account.id, limit + 1, offset);
    if (!result) {
      throw new ForumError('topic_not_found', 404);
    }
    return {
      hasMore: result.posts.length > limit,
      nextOffset: offset + Math.min(result.posts.length, limit),
      posts: result.posts.slice(0, limit),
      topic: result.topic,
    };
  }

  async function listPostReactions(sessionToken, postId, query = {}) {
    const session = await authService.getSession(sessionToken);
    const id = parseId(postId, 'invalid_post');
    const reaction = query.reaction ?? null;
    if (reaction !== null && !isValidReaction(reaction)) {
      throw new ForumError('invalid_reaction', 400);
    }
    const limit = parsePageLimit(query.limit, reaction ? 5 : 50);
    const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const reactions = await repository.listPostReactions(
      session.account.id,
      id,
      reaction,
      limit + 1,
      offset,
    );
    if (reactions === null) {
      throw new ForumError('post_unavailable', 404);
    }
    return {
      hasMore: reactions.length > limit,
      nextOffset: offset + Math.min(reactions.length, limit),
      reactions: reactions.slice(0, limit),
    };
  }

  async function setPostReaction(sessionToken, csrfToken, postId, input) {
    const account = await requireMutation(sessionToken, csrfToken);
    const id = parseId(postId, 'invalid_post');
    if (!isValidReaction(input?.reaction)) {
      throw new ForumError('invalid_reaction', 400);
    }
    const post = await repository.setPostReaction(account.id, id, input.reaction);
    if (!post) {
      throw new ForumError('post_unavailable', 404);
    }
    return post;
  }

  async function clearPostReaction(sessionToken, csrfToken, postId) {
    const account = await requireMutation(sessionToken, csrfToken);
    const id = parseId(postId, 'invalid_post');
    const post = await repository.clearPostReaction(account.id, id);
    if (!post) {
      throw new ForumError('post_unavailable', 404);
    }
    return post;
  }

  async function createTopic(sessionToken, csrfToken, input) {
    const account = await requireMutation(sessionToken, csrfToken);
    const subforumKey = parseSubforumKey(input.subforum);
    requireSubforumAccess(account, subforumKey);
    const title = boundedText(input.title, 3, 120, 'invalid_topic_title');
    const body = boundedText(input.body, 1, 10_000, 'invalid_post_body');
    await authService.requireTopicCreationAllowed(account);
    const created = await repository.createTopic(
      account.id,
      subforumKey,
      title,
      body,
      extractMarkdownMentionUsernames(body),
    );
    if (!created) {
      throw new ForumError('subforum_not_found', 404);
    }
    return created;
  }

  async function createPost(sessionToken, csrfToken, topicId, input) {
    const account = await requireMutation(sessionToken, csrfToken);
    const id = parseId(topicId, 'invalid_topic');
    const body = boundedText(input.body, 1, 10_000, 'invalid_post_body');
    await authService.requireForumPostingAllowed(account);
    const post = await repository.createPost(account.id, id, body, extractMarkdownMentionUsernames(body));
    if (!post) {
      throw new ForumError('topic_unavailable', 409);
    }
    return post;
  }

  async function createPostAttachment(sessionToken, csrfToken, postId, input) {
    const account = await requireMutation(sessionToken, csrfToken);
    authService.requireForumPostingEnabled(account);
    if (!attachmentProcessor) {
      throw new ForumError('attachments_unavailable', 503);
    }
    const id = parseId(postId, 'invalid_post');
    const fileName = parseAttachmentName(input.name);
    const now = clock();
    const moderator = hasPermission(account, permissions.postsModerate);
    const ownerEditCutoff = new Date(now.getTime() - editWindowMs);
    const authorization = await repository.authorizePostAttachment({
      accountId: account.id,
      moderator,
      ownerEditCutoff,
      postId: id,
    });
    if (authorization.status === 'not_found') {
      throw new ForumError('post_not_found', 404);
    }
    if (authorization.status === 'denied') {
      throw new ForumError('post_attachment_denied', 403);
    }
    const data = typeof input.data === 'function' ? await input.data() : input.data;
    const attachment = await attachmentProcessor.validate(data);
    const result = await repository.createPostAttachment({
      accountId: account.id,
      contentType: attachment.contentType,
      data: attachment.data,
      fileName,
      maximumCount: maximumAttachmentsPerPost,
      moderator,
      ownerEditCutoff,
      postId: id,
      quotaBytes: attachmentAccountQuotaBytes,
    });
    if (result.status === 'not_found') {
      throw new ForumError('post_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new ForumError('post_attachment_denied', 403);
    }
    if (result.status === 'limit') {
      throw new ForumError('attachment_limit_reached', 409);
    }
    if (result.status === 'quota') {
      throw new ForumError('attachment_quota_exceeded', 409);
    }
    return result.attachment;
  }

  async function deletePostAttachment(sessionToken, csrfToken, attachmentId, input = {}) {
    const account = await requireMutation(sessionToken, csrfToken);
    const id = parseId(attachmentId, 'invalid_attachment');
    const moderator = hasPermission(account, permissions.postsModerate);
    const reason = moderator
      ? boundedText(input.reason, 3, 200, 'invalid_delete_reason')
      : null;
    const now = clock();
    const result = await repository.deletePostAttachment({
      accountId: account.id,
      attachmentId: id,
      moderator,
      ownerEditCutoff: new Date(now.getTime() - editWindowMs),
      reason,
    });
    if (result.status === 'not_found') {
      throw new ForumError('attachment_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new ForumError('post_attachment_denied', 403);
    }
    return result.attachment;
  }

  async function getPostAttachment(sessionToken, attachmentId) {
    const session = await authService.getSession(sessionToken);
    const attachment = await repository.getPostAttachment(
      session.account.id,
      parseId(attachmentId, 'invalid_attachment'),
    );
    if (!attachment) {
      throw new ForumError('attachment_not_found', 404);
    }
    return attachment;
  }

  async function editTopic(sessionToken, csrfToken, topicId, input) {
    const account = await requireMutation(sessionToken, csrfToken);
    authService.requireForumPostingEnabled(account);
    const id = parseId(topicId, 'invalid_topic');
    const title = boundedText(input.title, 3, 120, 'invalid_topic_title');
    const expectedUpdatedAt = parseExpectedUpdatedAt(
      input.expectedUpdatedAt,
      'invalid_topic_version',
    );
    const moderator = hasPermission(account, permissions.postsModerate);
    const reason = input.reason === undefined || input.reason === null || input.reason === ''
      ? null
      : boundedText(input.reason, 3, 200, 'invalid_edit_reason');
    const result = await repository.editTopic({
      actorId: account.id,
      expectedUpdatedAt,
      moderator,
      reason,
      title,
      topicId: id,
      updatedAt: clock(),
    });
    if (result.status === 'not_found') {
      throw new ForumError('topic_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new ForumError('topic_edit_denied', 403);
    }
    if (result.status === 'conflict') {
      throw new ForumError('topic_edit_conflict', 409);
    }
    if (result.status === 'reason_required') {
      throw new ForumError('invalid_edit_reason', 400);
    }
    return result.topic;
  }

  async function editPost(sessionToken, csrfToken, postId, input) {
    const account = await requireMutation(sessionToken, csrfToken);
    authService.requireForumPostingEnabled(account);
    const id = parseId(postId, 'invalid_post');
    const body = boundedText(input.body, 1, 10_000, 'invalid_post_body');
    const expectedUpdatedAt = parseExpectedUpdatedAt(
      input.expectedUpdatedAt,
      'invalid_post_version',
    );
    const moderator = hasPermission(account, permissions.postsModerate);
    const reason = input.reason === undefined || input.reason === null || input.reason === ''
      ? null
      : boundedText(input.reason, 3, 200, 'invalid_edit_reason');
    const updatedAt = clock();
    const result = await repository.editPost({
      actorId: account.id,
      body,
      expectedUpdatedAt,
      mentions: extractMarkdownMentionUsernames(body),
      moderator,
      ownerEditCutoff: new Date(updatedAt.getTime() - editWindowMs),
      postId: id,
      reason,
      updatedAt,
    });
    if (result.status === 'not_found') {
      throw new ForumError('post_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new ForumError('post_edit_denied', 403);
    }
    if (result.status === 'reason_required') {
      throw new ForumError('invalid_edit_reason', 400);
    }
    if (result.status === 'conflict') {
      throw new ForumError('post_edit_conflict', 409);
    }
    return result.post;
  }

  async function deletePost(sessionToken, csrfToken, postId, input = {}) {
    const account = await requireMutation(sessionToken, csrfToken);
    const id = parseId(postId, 'invalid_post');
    const moderator = hasPermission(account, permissions.postsModerate);
    const reason = moderator
      ? boundedText(input.reason, 3, 200, 'invalid_delete_reason')
      : null;
    const deletedAt = clock();
    const result = await repository.deletePost({
      actorId: account.id,
      deletedAt,
      moderator,
      ownerEditCutoff: new Date(deletedAt.getTime() - editWindowMs),
      postId: id,
      reason,
    });
    if (result.status === 'not_found') {
      throw new ForumError('post_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new ForumError('post_delete_denied', 403);
    }
    return result.post;
  }

  async function restorePost(sessionToken, csrfToken, postId, input) {
    const account = await requireMutation(sessionToken, csrfToken);
    requirePermission(account, permissions.postsModerate);
    const id = parseId(postId, 'invalid_post');
    const expectedUpdatedAt = parseExpectedUpdatedAt(
      input.expectedUpdatedAt,
      'invalid_post_version',
    );
    const reason = boundedText(input.reason, 3, 200, 'invalid_restore_reason');
    const result = await repository.restorePost({
      actorId: account.id,
      expectedUpdatedAt,
      postId: id,
      reason,
      restoredAt: clock(),
    });
    if (result.status === 'not_found') {
      throw new ForumError('post_not_found', 404);
    }
    if (result.status === 'conflict') {
      throw new ForumError('post_restore_conflict', 409);
    }
    return result.post;
  }

  async function deleteTopic(sessionToken, csrfToken, topicId, input = {}) {
    const account = await requireMutation(sessionToken, csrfToken);
    const id = parseId(topicId, 'invalid_topic');
    const moderator = hasPermission(account, permissions.postsModerate);
    const reason = moderator
      ? boundedText(input.reason, 3, 200, 'invalid_delete_reason')
      : null;
    const result = await repository.deleteTopic({
      actorId: account.id,
      deletedAt: clock(),
      moderator,
      reason,
      topicId: id,
    });
    if (result.status === 'not_found') {
      throw new ForumError('topic_not_found', 404);
    }
    if (result.status === 'denied') {
      throw new ForumError('topic_delete_denied', 403);
    }
    return result.topic;
  }

  async function setTopicLocked(sessionToken, csrfToken, topicId, locked) {
    const account = await requireMutation(sessionToken, csrfToken);
    requirePermission(account, permissions.postsModerate);
    if (typeof locked !== 'boolean') {
      throw new ForumError('invalid_topic_lock', 400);
    }
    const topic = await repository.setTopicLocked(
      parseId(topicId, 'invalid_topic'),
      locked,
      account.id,
      clock(),
    );
    if (!topic) {
      throw new ForumError('topic_not_found', 404);
    }
    return topic;
  }

  async function setTopicSubscription(sessionToken, csrfToken, topicId, subscribed) {
    const account = await requireMutation(sessionToken, csrfToken);
    const id = parseId(topicId, 'invalid_topic');
    if (typeof subscribed !== 'boolean') {
      throw new ForumError('invalid_topic_subscription', 400);
    }
    const subscription = await repository.setTopicSubscription(account.id, id, subscribed);
    if (!subscription) {
      throw new ForumError('topic_not_found', 404);
    }
    return subscription;
  }

  return {
    clearPostReaction,
    createPost,
    createPostAttachment,
    createTopic,
    deletePostAttachment,
    deletePost,
    deleteTopic,
    editTopic,
    editPost,
    getTopic,
    getPostAttachment,
    inspectDeletedPost,
    listPostReactions,
    listTopics,
    restorePost,
    searchContent,
    setTopicLocked,
    setPostReaction,
    setTopicSubscription,
  };
}