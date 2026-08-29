import { isValidUsername, normalizeUsername } from './username.js';
import { stripHtmlTags } from './authored-text.js';
import { normalizeDatabaseId } from './database-id.js';
import { isAdministrator } from './policy.js';
import { parseIsoTimestamp } from './timestamp.js';
import {
  digestUsernameColorUnlockCode,
  usernameColorEffects,
} from './username-color-effects.js';

const profileActivityLimit = 10;
const profileContentLimit = 10;
const maximumProfileContentPageSize = 50;
const mentionUsernameLimit = 10;
const usernameRenameHistoryLimit = 10;
const usernameRenameWindowMs = 7 * 24 * 60 * 60 * 1000;
const mentionUsernamePrefixPattern = /^(?=.{1,32}$)[a-z0-9][a-z0-9_-]*(?: [a-z0-9_-]+)?$/;
const usernameColors = new Set(['default', 'forest', 'red', 'blue', 'gold', 'teal']);
const timestampColors = new Set(['default', 'forest', 'red', 'blue', 'gold', 'teal']);
const usernameHexColorPattern = /^#[0-9a-f]{6}$/i;
const usernameColorEffectSet = new Set(usernameColorEffects);

export class ProfileError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateDescription(value) {
  if (typeof value !== 'string') {
    throw new ProfileError('invalid_profile_description', 400);
  }
  const description = stripHtmlTags(value).trim();
  if (description.length > 500) {
    throw new ProfileError('invalid_profile_description', 400);
  }
  return description;
}

function validateProfileText(value, maximumLength, errorCode) {
  if (typeof value !== 'string') {
    throw new ProfileError(errorCode, 400);
  }
  const normalized = stripHtmlTags(value).trim();
  if (normalized.length > maximumLength) {
    throw new ProfileError(errorCode, 400);
  }
  return normalized;
}

function validateSignature(value) {
  if (typeof value !== 'string') {
    throw new ProfileError('invalid_profile_signature', 400);
  }
  const signature = stripHtmlTags(value).replace(/\r\n?/g, '\n').trim();
  if (signature.length > 3000 || signature.split('\n').length > 3) {
    throw new ProfileError('invalid_profile_signature', 400);
  }
  return signature;
}

function validateUsernameColor(value) {
  if (usernameColors.has(value)) {
    return value;
  }
  if (typeof value !== 'string' || !usernameHexColorPattern.test(value)) {
    throw new ProfileError('invalid_username_color', 400);
  }
  return value.toLowerCase();
}

function validateUsernameColorEffect(value) {
  if (!usernameColorEffectSet.has(value)) {
    throw new ProfileError('invalid_username_color_effect', 400);
  }
  return value;
}

function validateTimestampColor(value) {
  if (timestampColors.has(value)) {
    return value;
  }
  if (typeof value !== 'string' || !usernameHexColorPattern.test(value)) {
    throw new ProfileError('invalid_timestamp_color', 400);
  }
  return value.toLowerCase();
}

function validateVisitorAreaVisibility(value) {
  if (typeof value !== 'boolean') {
    throw new ProfileError('invalid_profile_visitor_area_visibility', 400);
  }
  return value;
}

function validateProfileBody(value) {
  const body = stripHtmlTags(typeof value === 'string' ? value : '').trim();
  if (!body || body.length > 10_000) {
    throw new ProfileError('invalid_profile_post_body', 400);
  }
  return body;
}

function parseProfileContentId(value) {
  const id = normalizeDatabaseId(value);
  if (!id) {
    throw new ProfileError('invalid_profile_post', 400);
  }
  return id;
}

function parseProfileContentVersion(value) {
  const expectedUpdatedAt = parseIsoTimestamp(value);
  if (!expectedUpdatedAt) {
    throw new ProfileError('invalid_profile_post_version', 400);
  }
  return expectedUpdatedAt;
}

function parsePageValue(value, fallback, maximum) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new ProfileError('invalid_profile_post_query', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ProfileError('invalid_profile_post_query', 400);
  }
  return parsed;
}

function parsePage(query = {}) {
  const limit = parsePageValue(query.limit, profileContentLimit, maximumProfileContentPageSize);
  if (limit === 0) {
    throw new ProfileError('invalid_profile_post_query', 400);
  }
  return {
    limit,
    offset: parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER),
  };
}

function requireMutationResult(result, kind, action) {
  if (result.status === 'not_found') {
    throw new ProfileError(`${kind}_not_found`, 404);
  }
  if (result.status === 'denied') {
    throw new ProfileError(`${kind}_${action}_denied`, 403);
  }
  if (result.status === 'conflict') {
    throw new ProfileError(`${kind}_edit_conflict`, 409);
  }
  return result.item;
}

export function createProfileService({
  authService,
  clock = () => new Date(),
  forumRepository,
  profilePostRepository,
  repository,
}) {
  async function searchMentionUsernames(sessionToken, prefix) {
    const session = await authService.getSession(sessionToken);
    const normalizedPrefix = normalizeUsername(prefix);
    if (!mentionUsernamePrefixPattern.test(normalizedPrefix)) {
      throw new ProfileError('invalid_username_prefix', 400);
    }
    const usernames = await repository.searchActiveUsernamesByPrefix(
      normalizedPrefix,
      session.account.id,
      mentionUsernameLimit,
    );
    return { usernames };
  }

  async function listUsernameRenameRequests(sessionToken) {
    const session = await authService.getSession(sessionToken);
    const requests = await repository.listOwnUsernameRenameRequests(
      session.account.id,
      usernameRenameHistoryLimit,
      0,
    );
    return { requests };
  }

  async function createUsernameRenameRequest(sessionToken, csrfToken, input) {
    const keys = input && !Array.isArray(input) ? Object.keys(input).sort() : [];
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    if (keys.length !== 1 || keys[0] !== 'username' || !isValidUsername(username)) {
      throw new ProfileError('invalid_username_rename_request', 400);
    }
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    const requestedAt = clock();
    const result = await repository.createUsernameRenameRequest({
      accountId: session.account.id,
      normalizedUsername: normalizeUsername(username),
      requestedAt,
      username,
      weeklyWindowMs: usernameRenameWindowMs,
    });
    if (result.status === 'account_unavailable') {
      throw new ProfileError('username_rename_unavailable', 403);
    }
    if (result.status === 'unchanged') {
      throw new ProfileError('username_rename_unchanged', 400);
    }
    if (result.status === 'pending') {
      throw new ProfileError('username_rename_pending', 409);
    }
    if (result.status === 'cooldown') {
      const error = new ProfileError('username_rename_cooldown', 429);
      error.retryAfterMs = Math.max(0, result.retryAt.getTime() - requestedAt.getTime());
      throw error;
    }
    if (result.status === 'unavailable') {
      throw new ProfileError('username_unavailable', 409);
    }
    if (result.status !== 'created' || !result.request) {
      throw new Error('invalid_username_rename_result');
    }
    return { request: result.request };
  }

  async function findProfile(sessionToken, username) {
    const session = await authService.getSession(sessionToken);
    const normalizedUsername = normalizeUsername(username);
    if (!isValidUsername(username)) {
      throw new ProfileError('profile_not_found', 404);
    }
    const profile = await repository.findPublicProfileByUsername(
      normalizedUsername,
      session.account.id,
    );
    if (!profile) {
      throw new ProfileError('profile_not_found', 404);
    }
    return { normalizedUsername, profile, session };
  }

  async function getProfile(sessionToken, username) {
    const { profile, session } = await findProfile(sessionToken, username);
    if (!profile.activityVisible) {
      return { profile, recentPosts: [], recentThreads: [] };
    }
    const [recentThreads, recentPosts] = await Promise.all([
      forumRepository.listTopicsByAccount(
        session.account.id,
        profile.id,
        profileActivityLimit,
      ),
      forumRepository.listPostsByAccount(
        session.account.id,
        profile.id,
        profileActivityLimit,
        0,
      ),
    ]);
    return { profile, recentPosts, recentThreads };
  }

  async function listProfileFollowers(sessionToken, username, query = {}) {
    const { profile, session } = await findProfile(sessionToken, username);
    const { limit, offset } = parsePage(query);
    const followers = await repository.listProfileFollowers(
      session.account.id,
      profile.id,
      limit + 1,
      offset,
    );
    return {
      followers: followers.slice(0, limit),
      hasMore: followers.length > limit,
      nextOffset: offset + Math.min(followers.length, limit),
    };
  }

  async function listProfilePosts(sessionToken, username, query = {}) {
    const { profile, session } = await findProfile(sessionToken, username);
    const { limit, offset } = parsePage(query);
    const posts = await profilePostRepository.listProfilePosts(
      session.account.id,
      profile.id,
      limit + 1,
      offset,
    );
    return {
      hasMore: posts.length > limit,
      nextOffset: offset + Math.min(posts.length, limit),
      posts: posts.slice(0, limit),
    };
  }

  async function listProfilePostComments(sessionToken, postId, query = {}) {
    const session = await authService.getSession(sessionToken);
    const id = parseProfileContentId(postId);
    const { limit, offset } = parsePage(query);
    const comments = await profilePostRepository.listProfilePostComments(
      session.account.id,
      id,
      limit + 1,
      offset,
    );
    if (!comments) {
      throw new ProfileError('profile_post_not_found', 404);
    }
    return {
      comments: comments.slice(0, limit),
      hasMore: comments.length > limit,
      nextOffset: offset + Math.min(comments.length, limit),
    };
  }

  async function listProfileVisitorPostComments(sessionToken, postId, query = {}) {
    const session = await authService.getSession(sessionToken);
    const id = parseProfileContentId(postId);
    const { limit, offset } = parsePage(query);
    const comments = await profilePostRepository.listProfileVisitorPostComments(
      session.account.id,
      id,
      limit + 1,
      offset,
    );
    if (!comments) {
      throw new ProfileError('profile_visitor_post_not_found', 404);
    }
    return {
      comments: comments.slice(0, limit),
      hasMore: comments.length > limit,
      nextOffset: offset + Math.min(comments.length, limit),
    };
  }

  async function listProfileVisitorPosts(sessionToken, username, query = {}) {
    const { profile, session } = await findProfile(sessionToken, username);
    const { limit, offset } = parsePage(query);
    const posts = await profilePostRepository.listProfileVisitorPosts(
      session.account.id,
      profile.id,
      limit + 1,
      offset,
    );
    if (!posts) {
      throw new ProfileError('profile_visitor_area_hidden', 404);
    }
    return {
      hasMore: posts.length > limit,
      nextOffset: offset + Math.min(posts.length, limit),
      posts: posts.slice(0, limit),
    };
  }

  async function requireProfileMutation(
    sessionToken,
    csrfToken,
    { editing = false, posting = false } = {},
  ) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    if (posting) {
      await authService.requireForumPostingAllowed(session.account);
    } else if (editing) {
      authService.requireForumPostingEnabled(session.account);
    }
    return session.account;
  }

  async function createProfilePost(sessionToken, csrfToken, username, input) {
    const account = await requireProfileMutation(sessionToken, csrfToken, { posting: true });
    const { profile } = await findProfile(sessionToken, username);
    if (profile.id !== account.id) {
      throw new ProfileError('profile_post_create_denied', 403);
    }
    const post = await profilePostRepository.createProfilePost({
      actorId: account.id,
      body: validateProfileBody(input.body),
      createdAt: clock(),
      profileId: profile.id,
    });
    if (!post) {
      throw new ProfileError('profile_post_create_denied', 403);
    }
    return post;
  }

  async function createProfilePostComment(sessionToken, csrfToken, postId, input) {
    const account = await requireProfileMutation(sessionToken, csrfToken, { posting: true });
    const item = await profilePostRepository.createProfilePostComment({
      actorId: account.id,
      body: validateProfileBody(input.body),
      createdAt: clock(),
      postId: parseProfileContentId(postId),
    });
    if (!item) {
      throw new ProfileError('profile_post_not_found', 404);
    }
    return item;
  }

  async function createProfileVisitorPost(sessionToken, csrfToken, username, input) {
    const account = await requireProfileMutation(sessionToken, csrfToken, { posting: true });
    const { profile } = await findProfile(sessionToken, username);
    if (profile.id === account.id) {
      throw new ProfileError('profile_visitor_post_create_denied', 403);
    }
    const item = await profilePostRepository.createProfileVisitorPost({
      actorId: account.id,
      body: validateProfileBody(input.body),
      createdAt: clock(),
      profileId: profile.id,
    });
    if (!item) {
      throw new ProfileError('profile_visitor_area_hidden', 404);
    }
    return item;
  }

  async function createProfileVisitorPostComment(sessionToken, csrfToken, postId, input) {
    const account = await requireProfileMutation(sessionToken, csrfToken, { posting: true });
    const item = await profilePostRepository.createProfileVisitorPostComment({
      actorId: account.id,
      body: validateProfileBody(input.body),
      createdAt: clock(),
      postId: parseProfileContentId(postId),
    });
    if (!item) {
      throw new ProfileError('profile_visitor_post_not_found', 404);
    }
    return item;
  }

  async function editProfileContent(sessionToken, csrfToken, id, input, kind) {
    const account = await requireProfileMutation(sessionToken, csrfToken, { editing: true });
    const result = await profilePostRepository.editProfileContent({
      actorId: account.id,
      body: validateProfileBody(input.body),
      expectedUpdatedAt: parseProfileContentVersion(input.expectedUpdatedAt),
      id: parseProfileContentId(id),
      kind,
      updatedAt: clock(),
    });
    return requireMutationResult(result, kind, 'edit');
  }

  async function deleteProfileContent(sessionToken, csrfToken, id, kind) {
    const account = await requireProfileMutation(sessionToken, csrfToken);
    const result = await profilePostRepository.deleteProfileContent({
      actorId: account.id,
      deletedAt: clock(),
      id: parseProfileContentId(id),
      kind,
    });
    return requireMutationResult(result, kind, 'delete');
  }

  async function setFollowing(sessionToken, csrfToken, username, following) {
    if (typeof following !== 'boolean') {
      throw new ProfileError('invalid_follow_state', 400);
    }
    const { normalizedUsername, profile, session } = await findProfile(sessionToken, username);
    await authService.requireCsrf(session, csrfToken);
    if (profile.id === session.account.id) {
      throw new ProfileError('cannot_follow_self', 409);
    }
    await repository.setFollowing(session.account.id, profile.id, following);
    return repository.findPublicProfileByUsername(
      normalizedUsername,
      session.account.id,
    );
  }

  async function updateProfile(sessionToken, csrfToken, input) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    if (input.timestampColor !== undefined && !isAdministrator(session.account)) {
      throw new ProfileError('timestamp_color_forbidden', 403);
    }
    const profile = await repository.updateProfile(session.account.id, {
      description: validateDescription(input.description),
      location: validateProfileText(input.location, 80, 'invalid_profile_location'),
      profileVisitorAreaVisible: validateVisitorAreaVisibility(
        input.profileVisitorAreaVisible
          ?? session.account.profileVisitorAreaVisible
          ?? true,
      ),
      signature: validateSignature(input.signature ?? session.account.signature ?? ''),
      ...(input.timestampColor === undefined
        ? {}
        : { timestampColor: validateTimestampColor(input.timestampColor) }),
      title: validateProfileText(input.title, 64, 'invalid_profile_title'),
      usernameColor: validateUsernameColor(input.usernameColor),
      usernameColorEffect: validateUsernameColorEffect(
        input.usernameColorEffect ?? session.account.usernameColorEffect ?? 'none',
      ),
    });
    if (!profile) {
      throw new ProfileError('username_color_effect_locked', 403);
    }
    return profile;
  }

  async function redeemUsernameColorUnlock(sessionToken, csrfToken, input) {
    const session = await authService.getSession(sessionToken);
    await authService.requireCsrf(session, csrfToken);
    const tokenDigest = digestUsernameColorUnlockCode(input.code);
    if (!tokenDigest) {
      throw new ProfileError('invalid_unlock_code', 400);
    }
    if (!await repository.redeemUsernameColorUnlockCode(session.account.id, tokenDigest)) {
      throw new ProfileError('invalid_unlock_code', 400);
    }
    return { usernameColorEffectsUnlocked: true };
  }

  return {
    createUsernameRenameRequest,
    createProfilePost,
    createProfilePostComment,
    createProfileVisitorPost,
    createProfileVisitorPostComment,
    deleteProfileContent,
    editProfileContent,
    getProfile,
    listProfileFollowers,
    listUsernameRenameRequests,
    listProfilePostComments,
    listProfilePosts,
    listProfileVisitorPosts,
    listProfileVisitorPostComments,
    redeemUsernameColorUnlock,
    searchMentionUsernames,
    setFollowing,
    updateProfile,
  };
}