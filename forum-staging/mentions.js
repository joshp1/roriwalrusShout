import { marked } from 'marked';

const segment = '[A-Za-z0-9][A-Za-z0-9_-]*';
const mentionPatternSource = String.raw`(^|[^A-Za-z0-9_@])@\[(${segment} ${segment})\](?=$|[^A-Za-z0-9_@])|(^|[^A-Za-z0-9_@])@(${segment})(?=$|[^A-Za-z0-9_-])`;
const mentionPattern = new RegExp(mentionPatternSource, 'g');
const usernamePattern = /^(?=.{3,32}$)[A-Za-z0-9][A-Za-z0-9_-]*(?: [A-Za-z0-9][A-Za-z0-9_-]*)?$/;

export class MentionError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function assertValidMentionUsernames(queryable, actorId, usernames) {
  if (!Array.isArray(usernames) || usernames.length === 0) {
    return;
  }
  const result = await queryable.query(
    `SELECT requested.username
     FROM unnest($1::text[]) WITH ORDINALITY requested(username, position)
     LEFT JOIN LATERAL (
       SELECT candidate.id
       FROM accounts candidate
       WHERE (
           candidate.normalized_username = requested.username
           OR EXISTS (
             SELECT 1 FROM account_username_history username_history
             WHERE username_history.account_id = candidate.id
               AND username_history.normalized_username = requested.username
           )
         )
         AND candidate.id <> $2
         AND candidate.membership_status = 'active'
         AND candidate.deleted_at IS NULL
         AND account_visible_to($2, candidate.id)
         AND account_visible_to(candidate.id, $2)
       LIMIT 1
     ) accounts ON true
     WHERE accounts.id IS NULL
     ORDER BY requested.position
     LIMIT 1`,
    [usernames, actorId],
  );
  if (result.rows[0]) {
    throw new MentionError('invalid_mention_username', 400);
  }
}

export function extractMentionUsernames(value) {
  const usernames = new Set();
  mentionPattern.lastIndex = 0;
  for (const match of String(value ?? '').matchAll(mentionPattern)) {
    const username = match[2] ?? match[4];
    if (usernamePattern.test(username)) {
      usernames.add(username.toLowerCase());
    }
  }
  return [...usernames];
}

const excludedMarkdownTokenTypes = new Set(['code', 'codespan', 'html', 'image', 'link']);

function collectMarkdownText(node, segments) {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectMarkdownText(child, segments);
    }
    return;
  }
  if (!node || typeof node !== 'object' || excludedMarkdownTokenTypes.has(node.type)) {
    return;
  }
  if (node.type === 'escape' || (node.type === 'text' && !Array.isArray(node.tokens))) {
    segments.push(node.text);
    return;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      collectMarkdownText(value, segments);
    }
  }
}

export function extractMarkdownMentionUsernames(value) {
  const segments = [];
  collectMarkdownText(marked.lexer(String(value ?? ''), { gfm: true }), segments);
  const usernames = new Set();
  for (const text of segments) {
    for (const username of extractMentionUsernames(text)) {
      usernames.add(username);
    }
  }
  return [...usernames];
}

export function filterMentionAccountAliases(body, mentionAccounts) {
  const mentionedUsernames = new Set(extractMarkdownMentionUsernames(body));
  return mentionAccounts.map((account) => ({
    ...account,
    aliases: (Array.isArray(account.aliases) ? account.aliases : []).filter((alias) => (
      mentionedUsernames.has(String(alias).toLowerCase())
    )),
  }));
}