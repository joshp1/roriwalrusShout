import { normalizeDatabaseId } from './database-id.js';
import { isValidReaction } from './reaction.js';

export { isValidReaction as isValidShoutReaction } from './reaction.js';

const maximumPageSize = 50;

export class ShoutReactionError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parsePageValue(value, fallback, maximum, allowZero = true) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new ShoutReactionError('invalid_reaction_query', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum || !allowZero && parsed === 0) {
    throw new ShoutReactionError('invalid_reaction_query', 400);
  }
  return parsed;
}

export function createShoutReactionService({ authService, repository }) {
  return Object.freeze({
    async listReactions(sessionToken, shoutId, query = {}) {
      const session = await authService.getSession(sessionToken);
      const id = normalizeDatabaseId(shoutId);
      if (!id) {
        throw new ShoutReactionError('invalid_shout', 400);
      }
      const reaction = query.reaction ?? null;
      if (reaction !== null && !isValidReaction(reaction)) {
        throw new ShoutReactionError('invalid_reaction', 400);
      }
      const limit = parsePageValue(query.limit, reaction ? 5 : 50, maximumPageSize, false);
      const offset = parsePageValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
      const rows = await repository.listShoutReactions(
        session.account.id,
        id,
        reaction,
        limit + 1,
        offset,
      );
      if (rows === null) {
        throw new ShoutReactionError('shout_unavailable', 404);
      }
      return {
        hasMore: rows.length > limit,
        nextOffset: offset + Math.min(rows.length, limit),
        reactions: rows.slice(0, limit),
      };
    },
  });
}