import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { filterMentionAccountAliases } from './mentions.js';
import { verifyRegistrationInviteToken } from './registration-invites.js';

const { Pool } = pg;
const maximumPinnedShoutsPerStream = 10;
const shoutSyncLockId = 1_847_672_020;
const serverDiagnosticLockId = 1_847_672_021;
const serverRestartLockId = 1_847_672_022;
const membershipDecisionMessages = new Map([
  ['active', 'Your membership is active.'],
  ['pending', 'Your membership status is pending.'],
  ['rejected', 'Your membership status is rejected.'],
  ['revoked', 'Your membership was revoked.'],
  ['suspended', 'Your membership was suspended.'],
]);

function escapeLikePattern(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function deletedAccountIdentity(accountId) {
  const suffix = accountId.toLowerCase().replaceAll('-', '').slice(0, 24);
  const normalizedUsername = `deleted-${suffix}`;
  return {
    email: `${normalizedUsername}@deleted.invalid`,
    normalizedUsername,
    username: 'Deleted account',
  };
}

function mapAccount(row) {
  return {
    avatarContentType: row.avatar_content_type,
    avatarUpdatedAt: row.avatar_updated_at,
    colorScheme: row.color_scheme ?? 'green',
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    description: row.description ?? '',
    displayName: row.display_name,
    email: row.email,
    emailVerifiedAt: row.email_verified_at,
    forcePasswordChange: row.force_password_change ?? false,
    fontSize: row.font_size ?? 'standard',
    fontTypeface: row.font_typeface ?? 'verdana',
    forumPostingMuted: row.forum_posting_muted ?? false,
    id: row.id,
    membershipStatus: row.membership_status ?? 'active',
    passwordHash: row.password_hash,
    permissions: row.permissions ?? [],
    profileVisitorAreaVisible: row.profile_visitor_area_visible ?? true,
    role: row.role,
    signature: row.signature ?? '',
    statusAndActivityVisible: row.status_and_activity_visible ?? true,
    shoutboxEnabled: row.shoutbox_enabled,
    shoutboxHeightLines: row.shoutbox_height_lines ?? 18,
    shoutboxMuted: row.shoutbox_muted,
    shoutboxOrder: row.shoutbox_order ?? 'oldest-first',
    shoutboxPostingMuted: row.shoutbox_posting_muted ?? false,
    theme: row.theme,
    timestampColor: row.timestamp_color ?? 'default',
    timeZone: row.time_zone ?? 'local',
    username: row.username,
    usernameColor: row.username_color ?? 'default',
    usernameColorEffect: row.username_color_effect ?? 'none',
    usernameColorEffectsUnlocked: Boolean(row.username_color_effects_unlocked_at),
    visibleToRole: row.visible_to_role ?? null,
    slowdownMs: row.slowdown_ms ?? 0,
  };
}

function mapPublicProfile(row) {
  return {
    activityVisible: Boolean(row.activity_visible),
    avatarContentType: row.avatar_updated_at ? row.avatar_content_type : null,
    avatarUrl: row.avatar_updated_at
      ? `/api/avatars/${row.id}?v=${new Date(row.avatar_updated_at).getTime()}`
      : null,
    createdAt: row.created_at,
    description: row.description,
    displayName: row.display_name,
    followedByViewer: Boolean(row.followed_by_viewer),
    followerCount: Number(row.follower_count ?? 0),
    id: row.id,
    location: row.location ?? '',
    online: Boolean(row.online),
    profileVisitorAreaVisible: row.profile_visitor_area_visible ?? true,
    signature: row.signature ?? '',
    specialStatus: ({ dev: 'Dev', owner: 'Owner' })[row.role] ?? null,
    timestampColor: row.timestamp_color ?? 'default',
    title: row.title ?? '',
    username: row.username,
    usernameColor: row.username_color,
    usernameColorEffect: row.username_color_effect ?? 'none',
    visibleToRole: row.visible_to_role ?? null,
  };
}

function mapProfileFollower(row) {
  return {
    avatarContentType: row.avatar_content_type,
    avatarUrl: row.avatar_updated_at
      ? `/api/avatars/${row.id}?v=${new Date(row.avatar_updated_at).getTime()}`
      : null,
    displayName: row.display_name,
    id: row.id,
    username: row.username,
  };
}

function mapNotification(row) {
  return {
    createdAt: row.created_at,
    href: row.href,
    id: row.id,
    message: row.message,
    readAt: row.read_at,
  };
}

function mapSession(row) {
  return {
    createdAt: row.created_at,
    current: Boolean(row.current),
    expiresAt: row.expires_at,
    id: row.id,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent ?? 'Unknown device',
  };
}

function mapPasskey(row) {
  return {
    backedUp: row.backed_up,
    counter: Number(row.counter),
    createdAt: row.credential_created_at ?? row.created_at,
    deviceType: row.device_type,
    id: row.credential_id ?? row.id,
    label: row.label,
    lastUsedAt: row.last_used_at,
    publicKey: row.public_key ? new Uint8Array(row.public_key) : null,
    transports: row.transports ?? [],
  };
}

function mapManagedAccount(row) {
  return {
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    email: row.email,
    forcePasswordChange: row.force_password_change,
    forumPostingMuted: row.forum_posting_muted ?? false,
    hasAvatar: Boolean(row.avatar_updated_at),
    id: row.id,
    membershipStatus: row.membership_status,
    permissions: row.permissions ?? [],
    role: row.role,
    slowdownMs: row.slowdown_ms,
    shoutboxPostingMuted: row.shoutbox_posting_muted ?? false,
    updatedAt: row.updated_at,
    username: row.username,
  };
}

function mapUsernameRenameRequest(row) {
  return {
    accountId: row.account_id,
    accountRole: row.account_role ?? null,
    currentAccountUsername: row.account_username ?? null,
    currentUsername: row.current_username,
    decidedAt: row.decided_at ?? null,
    decisionReason: row.decision_reason ?? null,
    id: String(row.id),
    requestedAt: row.requested_at,
    requestedUsername: row.requested_username,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function mapAuditEvent(row) {
  return {
    action: row.action,
    actorId: row.actor_account_id,
    createdAt: row.created_at,
    details: row.details,
    id: String(row.id),
    reason: row.reason,
    targetId: row.target_account_id,
  };
}

function mapAuthenticationAuditEvent(row) {
  return {
    accountId: row.account_id,
    action: row.action,
    createdAt: row.created_at,
    details: row.details,
    id: String(row.id),
  };
}

function mapSiteSettings(row) {
  return {
    accessBlockReason: row.access_block_reason ?? null,
    accessBlocked: row.access_blocked ?? false,
    globalRegistrationTokenConfigured: row.global_registration_token_configured
      ?? row.global_registration_token_lookup_digest !== null,
    globalRegistrationTokenEnabled: row.global_registration_token_enabled,
    globalRegistrationTokenExpiresAt: row.global_registration_token_expires_at ?? null,
    globalRegistrationTokenIssuedAt: row.global_registration_token_issued_at ?? null,
    presenceCounterEnabled: row.presence_counter_enabled,
    shoutboxVisibilityCount: row.shoutbox_visibility_count,
    shoutboxVisibilityDays: Math.ceil(row.shoutbox_visibility_hours / 24),
    shoutboxVisibilityMode: row.shoutbox_visibility_mode,
    updatedAt: row.updated_at,
  };
}

function mapShout(row) {
  const mentionAccounts = filterMentionAccountAliases(row.body, row.mention_accounts ?? [])
    .map((account) => ({
    aliases: Array.isArray(account.aliases) ? account.aliases : [],
    username: account.username,
    usernameColor: account.usernameColor ?? 'default',
    usernameColorEffect: account.usernameColorEffect ?? 'none',
    }));
  const staffMentioned = Boolean(row.staff_mentioned);
  if (staffMentioned) {
    mentionAccounts.push({
      aliases: [],
      group: true,
      username: 'staff',
      usernameColor: 'default',
      usernameColorEffect: 'none',
    });
  }
  const viewerReactions = row.viewer_reactions
    ?? (row.viewer_reaction ? [row.viewer_reaction] : []);
  return {
    author: row.display_name,
    authorId: row.account_id,
    authorRole: row.role,
    authorUsername: row.username,
    avatarContentType: row.avatar_updated_at ? row.avatar_content_type : null,
    avatarUrl: row.avatar_updated_at
      ? `/api/avatars/${row.account_id}?v=${new Date(row.avatar_updated_at).getTime()}`
      : null,
    body: row.body,
    createdAt: row.created_at,
    id: String(row.id),
    mentionAccounts,
    mentionUsernames: row.mention_usernames
      ?? mentionAccounts.map((account) => account.username),
    pinnedAt: row.pinned_at ?? null,
    reactions: row.reactions ?? [],
    staffMentioned,
    streamKey: row.stream_key ?? 'public',
    syncCursor: row.sync_cursor == null ? null : String(row.sync_cursor),
    timestampColor: row.timestamp_color ?? 'default',
    updatedAt: row.updated_at ?? row.created_at,
    viewerReaction: viewerReactions[0] ?? null,
    viewerReactions,
    usernameColor: row.username_color,
    usernameColorEffect: row.username_color_effect ?? 'none',
    visibleToRole: row.visible_to_role ?? null,
  };
}

function mapShoutChange(row) {
  const cursor = String(row.sync_cursor);
  if (row.deleted_at) {
    return { cursor, id: String(row.id), type: 'delete' };
  }
  return { cursor, shout: mapShout(row), type: 'upsert' };
}

function mapShoutFlag(row) {
  return {
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? null,
    decidedByUsername: row.decided_by_username ?? null,
    decisionReason: row.decision_reason ?? null,
    id: String(row.id),
    reason: row.reason,
    reporterUsername: row.reporter_username ?? null,
    shoutId: String(row.shout_id),
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function createDatabasePool(connectionString, { statementTimeout = 10_000 } = {}) {
  return new Pool({
    connectionString,
    max: 10,
    statement_timeout: statementTimeout,
  });
}

export function createDatabaseReadinessCheck(pool, { timeoutMs = 1000 } = {}) {
  return async function checkDatabaseReadiness() {
    const result = await pool.query({
      query_timeout: timeoutMs,
      text: 'SELECT 1 AS ready',
    });
    return result.rows[0]?.ready === 1;
  };
}

export function createRepository(pool, { dummyPasswordHash }) {
  async function withTransaction(operation) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function lockShoutSyncCursor(client) {
    await client.query('SELECT pg_advisory_xact_lock($1)', [shoutSyncLockId]);
  }

  async function prepareServerDiagnostic(client) {
    const lock = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [serverDiagnosticLockId],
    );
    if (!lock.rows[0]?.locked) {
      return false;
    }
    await client.query("SET LOCAL statement_timeout = '2000ms'");
    return true;
  }

  async function insertServerDiagnosticAudit(client, {
    action,
    actorId,
    createdAt,
    details,
    reason,
  }) {
    await client.query(
      `INSERT INTO moderation_audit_events (
         actor_account_id, target_account_id, action, reason, details, created_at
       ) VALUES ($1, NULL, $2, $3, $4::jsonb, $5)`,
      [actorId, action, reason, JSON.stringify(details), createdAt],
    );
  }

  async function selectShoutHistoryPage(queryable, {
    before = null,
    historyCount = null,
    historyHours = null,
    limit,
    streamKey = 'public',
    viewerId = null,
  }) {
    const result = await queryable.query(
      `WITH retained_shouts AS MATERIALIZED (
         SELECT shouts.id, shouts.created_at
         FROM shouts JOIN accounts ON accounts.id = shouts.account_id
         WHERE shouts.deleted_at IS NULL
           AND account_visible_to($2, accounts.id)
           AND shouts.stream_key = $7
           AND shoutbox_stream_visible_to($2, $7)
           AND ($2::uuid IS NULL OR shouts.created_at >= (
             SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $2
           ))
           AND ($3::integer IS NULL OR shouts.created_at >= now() - ($3 * interval '1 hour'))
         ORDER BY shouts.created_at DESC, shouts.id DESC
         LIMIT $4
       ), paged_shouts AS (
         SELECT id, created_at FROM retained_shouts
         WHERE $5::timestamptz IS NULL
           OR (created_at, id) < ($5::timestamptz, $6::bigint)
         ORDER BY created_at DESC, id DESC
         LIMIT $1
       )
      SELECT shouts.id, shouts.account_id, shouts.body, shouts.created_at,
       shouts.updated_at, shouts.pinned_at, shouts.sync_cursor, shouts.stream_key,
        accounts.display_name, accounts.username, accounts.role, accounts.username_color,
        accounts.username_color_effect, accounts.timestamp_color, accounts.visible_to_role,
        accounts.avatar_content_type, accounts.avatar_updated_at,
        EXISTS (
          SELECT 1 FROM shout_staff_mentions
          WHERE shout_staff_mentions.shout_id = shouts.id
            AND shout_staff_mentions.active
        ) AS staff_mentioned,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'username', mentioned.username,
            'aliases', (
              SELECT COALESCE(jsonb_agg(username_history.username ORDER BY username_history.ended_at, username_history.id), '[]'::jsonb)
              FROM account_username_history username_history
              WHERE username_history.account_id = mentioned.id
            ),
            'usernameColor', mentioned.username_color,
            'usernameColorEffect', mentioned.username_color_effect
          ) ORDER BY mentioned.normalized_username)
          FROM shout_mentions
          JOIN accounts mentioned ON mentioned.id = shout_mentions.mentioned_account_id
          WHERE shout_mentions.shout_id = shouts.id
            AND mentioned.membership_status = 'active'
            AND mentioned.deleted_at IS NULL
            AND account_visible_to($2, mentioned.id)
        ), '[]'::jsonb) AS mention_accounts,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('count', reaction_counts.count, 'reaction', reaction_counts.reaction)
            ORDER BY reaction_counts.reaction
          )
          FROM (
            SELECT reactions.reaction, count(*)::integer AS count
            FROM shout_reactions reactions
            JOIN accounts reacting_accounts ON reacting_accounts.id = reactions.account_id
            WHERE reactions.shout_id = shouts.id
              AND account_visible_to($2, reacting_accounts.id)
            GROUP BY reactions.reaction
          ) reaction_counts
        ), '[]'::jsonb) AS reactions,
        ARRAY(
          SELECT viewer_reactions.reaction
          FROM shout_reactions viewer_reactions
          WHERE viewer_reactions.shout_id = shouts.id
            AND viewer_reactions.account_id = $2
          ORDER BY viewer_reactions.reaction
        ) AS viewer_reactions
       FROM paged_shouts
       JOIN shouts ON shouts.id = paged_shouts.id
       JOIN accounts ON accounts.id = shouts.account_id
       ORDER BY paged_shouts.created_at DESC, paged_shouts.id DESC`,
      [
        limit + 1,
        viewerId,
        historyHours,
        historyCount,
        before?.createdAt ?? null,
        before?.id ?? null,
        streamKey,
      ],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const oldest = rows.at(-1);
    return {
      history: rows.reverse().map(mapShout),
      historyHasMore: hasMore,
      historyNextBefore: hasMore && oldest ? {
        createdAt: oldest.created_at.toISOString(),
        id: String(oldest.id),
      } : null,
    };
  }

  async function selectShouts(
    queryable,
    limit,
    viewerId = null,
    historyHours = null,
    streamKey = 'public',
  ) {
    const page = await selectShoutHistoryPage(queryable, {
      historyHours,
      limit,
      streamKey,
      viewerId,
    });
    return page.history;
  }

  async function selectShoutById(queryable, shoutId, viewerId, streamKey = 'public') {
    const result = await queryable.query(
      `SELECT shouts.id, shouts.account_id, shouts.body, shouts.created_at,
        shouts.updated_at, shouts.pinned_at, shouts.sync_cursor, shouts.stream_key,
        accounts.display_name, accounts.username, accounts.role, accounts.username_color,
        accounts.username_color_effect, accounts.timestamp_color, accounts.visible_to_role,
        accounts.avatar_content_type, accounts.avatar_updated_at,
        EXISTS (
          SELECT 1 FROM shout_staff_mentions
          WHERE shout_staff_mentions.shout_id = shouts.id
            AND shout_staff_mentions.active
        ) AS staff_mentioned,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'username', mentioned.username,
            'aliases', (
              SELECT COALESCE(jsonb_agg(username_history.username ORDER BY username_history.ended_at, username_history.id), '[]'::jsonb)
              FROM account_username_history username_history
              WHERE username_history.account_id = mentioned.id
            ),
            'usernameColor', mentioned.username_color,
            'usernameColorEffect', mentioned.username_color_effect
          ) ORDER BY mentioned.normalized_username)
          FROM shout_mentions
          JOIN accounts mentioned ON mentioned.id = shout_mentions.mentioned_account_id
          WHERE shout_mentions.shout_id = shouts.id
            AND mentioned.membership_status = 'active'
            AND mentioned.deleted_at IS NULL
            AND account_visible_to($2, mentioned.id)
        ), '[]'::jsonb) AS mention_accounts,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('count', reaction_counts.count, 'reaction', reaction_counts.reaction)
            ORDER BY reaction_counts.reaction
          )
          FROM (
            SELECT reactions.reaction, count(*)::integer AS count
            FROM shout_reactions reactions
            JOIN accounts reacting_accounts ON reacting_accounts.id = reactions.account_id
            WHERE reactions.shout_id = shouts.id
              AND account_visible_to($2, reacting_accounts.id)
            GROUP BY reactions.reaction
          ) reaction_counts
        ), '[]'::jsonb) AS reactions,
        ARRAY(
          SELECT viewer_reactions.reaction
          FROM shout_reactions viewer_reactions
          WHERE viewer_reactions.shout_id = shouts.id
            AND viewer_reactions.account_id = $2
          ORDER BY viewer_reactions.reaction
        ) AS viewer_reactions
       FROM shouts JOIN accounts ON accounts.id = shouts.account_id
       WHERE shouts.id = $1 AND shouts.deleted_at IS NULL
        AND account_visible_to($2, accounts.id)
        AND shouts.stream_key = $3
        AND shoutbox_stream_visible_to($2, $3)`,
      [shoutId, viewerId, streamKey],
    );
    return result.rows[0] ? mapShout(result.rows[0]) : null;
  }

  async function selectPinnedShouts(
    queryable,
    viewerId,
    streamKey = 'public',
    limit = maximumPinnedShoutsPerStream,
  ) {
    const result = await queryable.query(
      `SELECT shouts.id
       FROM shouts JOIN accounts ON accounts.id = shouts.account_id
       WHERE shouts.deleted_at IS NULL AND shouts.pinned_at IS NOT NULL
         AND account_visible_to($1, accounts.id)
         AND shouts.stream_key = $2
         AND shoutbox_stream_visible_to($1, $2)
       ORDER BY shouts.pinned_at DESC, shouts.id DESC
       LIMIT $3`,
      [viewerId, streamKey, limit],
    );
    const shouts = await Promise.all(result.rows.map(
      ({ id }) => selectShoutById(queryable, id, viewerId, streamKey),
    ));
    return shouts.filter(Boolean);
  }

  async function reconcileShoutMentions(client, actorId, shoutId, mentions, streamKey) {
    await client.query(
      `DELETE FROM shout_mentions existing
       WHERE existing.shout_id = $3
         AND NOT EXISTS (
           SELECT 1 FROM accounts
           WHERE accounts.id = existing.mentioned_account_id
             AND (
               accounts.normalized_username = ANY($1::text[])
               OR EXISTS (
                 SELECT 1 FROM account_username_history username_history
                 WHERE username_history.account_id = accounts.id
                   AND username_history.normalized_username = ANY($1::text[])
               )
             )
             AND accounts.id <> $2
             AND accounts.membership_status = 'active'
             AND accounts.deleted_at IS NULL
             AND account_visible_to($2, accounts.id)
             AND account_visible_to(accounts.id, $2)
                  AND shoutbox_stream_visible_to(accounts.id, $4)
         )`,
                [mentions, actorId, shoutId, streamKey],
    );
    const result = await client.query(
      `WITH resolved_mentions AS (
        SELECT id, normalized_username, username, username_color, username_color_effect,
           ARRAY(
             SELECT username_history.username
             FROM account_username_history username_history
             WHERE username_history.account_id = accounts.id
               AND username_history.normalized_username = ANY($1::text[])
             ORDER BY username_history.ended_at, username_history.id
           ) AS aliases
         FROM accounts
         WHERE (
             normalized_username = ANY($1::text[])
             OR EXISTS (
               SELECT 1 FROM account_username_history username_history
               WHERE username_history.account_id = accounts.id
                 AND username_history.normalized_username = ANY($1::text[])
             )
           )
           AND id <> $2
           AND membership_status = 'active'
           AND deleted_at IS NULL
           AND account_visible_to($2, id)
           AND account_visible_to(id, $2)
             AND shoutbox_stream_visible_to(id, $4)
       ), inserted_mentions AS (
         INSERT INTO shout_mentions (shout_id, mentioned_account_id)
         SELECT $3, id FROM resolved_mentions
         ON CONFLICT DO NOTHING
         RETURNING mentioned_account_id
       ), inserted_notifications AS (
       INSERT INTO notifications (account_id, message, href, shout_id)
       SELECT inserted_mentions.mentioned_account_id,
         actor.username || ' mentioned you in Shoutbox', '/', $3
       FROM inserted_mentions
       JOIN accounts actor ON actor.id = $2
       RETURNING account_id
       )
       SELECT resolved_mentions.aliases, resolved_mentions.username,
         resolved_mentions.username_color,
         resolved_mentions.username_color_effect
       FROM resolved_mentions
       LEFT JOIN inserted_notifications
         ON inserted_notifications.account_id = resolved_mentions.id
       ORDER BY resolved_mentions.normalized_username`,
      [mentions, actorId, shoutId, streamKey],
    );
    return result.rows.map((row) => ({
      aliases: row.aliases ?? [],
      username: row.username,
      usernameColor: row.username_color,
      usernameColorEffect: row.username_color_effect ?? 'none',
    }));
  }

  async function reconcileShoutStaffMention(client, actorId, shoutId, mentions, streamKey) {
    const staffMentioned = mentions.includes('staff');
    const currentResult = await client.query(
      `SELECT active FROM shout_staff_mentions
       WHERE shout_id = $1
       FOR UPDATE`,
      [shoutId],
    );
    const current = currentResult.rows[0];
    if (Boolean(current?.active) === staffMentioned && (current || !staffMentioned)) {
      return staffMentioned;
    }
    if (!staffMentioned) {
      await client.query(
        `UPDATE shout_staff_mentions
         SET active = false, updated_at = now()
         WHERE shout_id = $1`,
        [shoutId],
      );
      return false;
    }
    await client.query(
      `INSERT INTO shout_staff_mentions (shout_id, active)
       VALUES ($1, true)
       ON CONFLICT (shout_id) DO UPDATE
       SET active = true, updated_at = now()`,
      [shoutId],
    );
    await client.query(
      `INSERT INTO notifications (
         account_id, message, href, shout_id, required_permission
       )
       SELECT staff.id,
         actor.username || ' mentioned @staff in Shoutbox',
         '/?shout=' || target_shout.id::text || '&stream=' || $3,
         target_shout.id,
         'shouts.moderate'
       FROM accounts staff
       JOIN accounts actor ON actor.id = $1
       JOIN shouts target_shout ON target_shout.id = $2
       WHERE staff.id <> $1
         AND staff.membership_status = 'active'
         AND staff.deleted_at IS NULL
         AND shoutbox_stream_visible_to(staff.id, 'staff')
         AND account_visible_to(staff.id, target_shout.account_id)
         AND shout_visible_to(staff.id, target_shout.id)`,
      [actorId, shoutId, streamKey],
    );
    return true;
  }

  return {
    dummyPasswordHash,
    async clearLoginBackoff(subjectDigest) {
      await pool.query(
        'DELETE FROM login_backoffs WHERE subject_digest = $1',
        [subjectDigest],
      );
    },
    async getAvatar(viewerId, accountId) {
      const result = await pool.query(
        `SELECT avatar_content_type, avatar_data FROM accounts
         WHERE id = $2
           AND membership_status = 'active'
           AND deleted_at IS NULL
           AND account_visible_to($1, id)`,
        [viewerId, accountId],
      );
      const row = result.rows[0];
      return row?.avatar_data
        ? { contentType: row.avatar_content_type, data: row.avatar_data }
        : null;
    },
    async consumeRateLimit({ action, limit, now, subjectDigest, windowMs }) {
      const result = await pool.query(
        `INSERT INTO auth_rate_limits (action, subject_digest, window_started_at, attempt_count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (action, subject_digest) DO UPDATE SET
           attempt_count = CASE
             WHEN auth_rate_limits.window_started_at <= $3 - ($4 * interval '1 millisecond') THEN 1
             ELSE auth_rate_limits.attempt_count + 1
           END,
           window_started_at = CASE
             WHEN auth_rate_limits.window_started_at <= $3 - ($4 * interval '1 millisecond') THEN $3
             ELSE auth_rate_limits.window_started_at
           END
         RETURNING attempt_count`,
        [action, subjectDigest, now, windowMs],
      );
      return result.rows[0].attempt_count <= limit;
    },
    async getLoginBackoff(subjectDigest, now) {
      const result = await pool.query(
        `SELECT GREATEST(
           0,
           CEIL(EXTRACT(EPOCH FROM (blocked_until - $2)) * 1000)
         )::bigint AS retry_after_ms
         FROM login_backoffs
         WHERE subject_digest = $1`,
        [subjectDigest, now],
      );
      return Number(result.rows[0]?.retry_after_ms ?? 0);
    },
    async recordLoginFailure({ accountId, now, resetAfterMs, subjectDigest }) {
      const result = await pool.query(
        `WITH updated AS (
           INSERT INTO login_backoffs (
             subject_digest, failure_count, last_failed_at, blocked_until
           ) VALUES ($1, 1, $2, $2)
           ON CONFLICT (subject_digest) DO UPDATE SET
             failure_count = CASE
               WHEN login_backoffs.last_failed_at <= $2 - ($3 * interval '1 millisecond') THEN 1
               ELSE LEAST(login_backoffs.failure_count + 1, 13)
             END,
             last_failed_at = $2,
             blocked_until = $2 + (
               CASE
                 WHEN login_backoffs.last_failed_at <= $2 - ($3 * interval '1 millisecond')
                   OR login_backoffs.failure_count < 2 THEN 0
                 ELSE LEAST(
                   900000,
                   1000 * POWER(2, LEAST(login_backoffs.failure_count + 1, 13) - 3)
                 )
               END * interval '1 millisecond'
             )
           RETURNING blocked_until
         ), audit_event AS (
           INSERT INTO authentication_audit_events (account_id, action)
           VALUES ($4, 'auth.login.credentials_rejected')
           RETURNING id
         )
         SELECT GREATEST(
           0,
           CEIL(EXTRACT(EPOCH FROM (blocked_until - $2)) * 1000)
         )::bigint AS retry_after_ms
         FROM updated CROSS JOIN audit_event`,
        [subjectDigest, now, resetAfterMs, accountId],
      );
      return Number(result.rows[0]?.retry_after_ms ?? 0);
    },
    async consumePasswordResetToken({ passwordHash, tokenDigest, usedAt }) {
      return withTransaction(async (client) => {
        const tokenResult = await client.query(
          `UPDATE password_reset_tokens
           SET consumed_at = $2
           WHERE token_digest = $1 AND consumed_at IS NULL AND expires_at > $2
           RETURNING account_id`,
          [tokenDigest, usedAt],
        );
        const accountId = tokenResult.rows[0]?.account_id;
        if (!accountId) {
          return false;
        }

        await client.query(
          `UPDATE accounts
           SET password_hash = $2, force_password_change = false, updated_at = $3
           WHERE id = $1`,
          [accountId, passwordHash, usedAt],
        );
        await client.query(
          `UPDATE password_reset_tokens SET consumed_at = $2
           WHERE account_id = $1 AND consumed_at IS NULL`,
          [accountId, usedAt],
        );
        await client.query(
          `UPDATE sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL`,
          [accountId, usedAt],
        );
        const removedPasskeys = await client.query(
          'DELETE FROM webauthn_credentials WHERE account_id = $1 RETURNING id',
          [accountId],
        );
        await client.query(
          `INSERT INTO notifications (account_id, message, href)
           VALUES ($1, 'Your password was changed, passkeys were removed, and other devices were signed out.', '/account#sign-in')`,
          [accountId],
        );
        await client.query(
          `INSERT INTO authentication_audit_events (account_id, action, details)
           VALUES ($1, 'auth.password_reset.completed', $2::jsonb)`,
          [accountId, JSON.stringify({ passkeysRemoved: removedPasskeys.rows.length })],
        );
        return true;
      });
    },
    async consumeVerificationToken(tokenDigest, usedAt) {
      return withTransaction(async (client) => {
        const tokenResult = await client.query(
          `UPDATE email_verification_tokens
           SET consumed_at = $2
           WHERE token_digest = $1 AND consumed_at IS NULL AND expires_at > $2
             AND EXISTS (
               SELECT 1 FROM accounts
               WHERE accounts.id = email_verification_tokens.account_id
                 AND accounts.membership_status = 'pending'
                 AND accounts.deleted_at IS NULL
             )
           RETURNING account_id`,
          [tokenDigest, usedAt],
        );
        const accountId = tokenResult.rows[0]?.account_id;
        if (!accountId) {
          return false;
        }

        const accountResult = await client.query(
          `UPDATE accounts
           SET email_verified_at = COALESCE(email_verified_at, $2),
             membership_status = 'active',
             updated_at = $2
           WHERE id = $1 AND membership_status = 'pending' AND deleted_at IS NULL
           RETURNING email`,
          [accountId, usedAt],
        );
        if (!accountResult.rows[0]) {
          return false;
        }
        await client.query(
          `INSERT INTO notifications (account_id, message, href)
           VALUES ($1, 'Your email is verified. Welcome to roriwalrus.', '/profile?tab=settings')`,
          [accountId],
        );
        await client.query(
          `INSERT INTO authentication_audit_events (account_id, action)
           VALUES ($1, 'auth.email.verified')`,
          [accountId],
        );
        return { email: accountResult.rows[0].email };
      });
    },
    async createAccount({
      email,
      inviteToken,
      inviteTokenDigest,
      normalizedUsername,
      passwordHash,
      registeredAt,
      rulesAgreedAt,
      rulesVersion,
      username,
    }) {
      return withTransaction(async (client) => {
        const globalTokenResult = await client.query(
          `SELECT global_registration_token_salt, global_registration_token_verifier
           FROM site_settings
           WHERE singleton = true
             AND global_registration_token_enabled = true
             AND global_registration_token_lookup_digest = $1
             AND global_registration_token_expires_at > $2
           FOR SHARE`,
          [inviteTokenDigest, registeredAt],
        );
        const globalToken = globalTokenResult.rows[0];
        const globalTokenValid = Boolean(globalToken) && await verifyRegistrationInviteToken(
          inviteToken,
          globalToken.global_registration_token_salt,
          globalToken.global_registration_token_verifier,
        );
        if (globalToken && !globalTokenValid) {
          return { account: null, created: false, inviteValid: false };
        }
        const inviteResult = globalTokenValid ? { rows: [] } : await client.query(
          `SELECT id, issuer_account_id, issuer_kind, token_salt, token_verifier
           FROM registration_invites
           WHERE token_lookup_digest = $1 AND issuer_kind = 'account'
             AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > $2
           FOR UPDATE`,
          [inviteTokenDigest, registeredAt],
        );
        const invite = inviteResult.rows[0];
        if (!globalTokenValid && (!invite || !await verifyRegistrationInviteToken(
          inviteToken,
          invite.token_salt,
          invite.token_verifier,
        ))) {
          return { account: null, created: false, inviteValid: false };
        }

        const reservationResult = await client.query(
          `INSERT INTO username_reservations (normalized_username)
           VALUES ($1) ON CONFLICT DO NOTHING RETURNING normalized_username`,
          [normalizedUsername],
        );
        if (!reservationResult.rows[0]) {
          const existingResult = await client.query(
            `SELECT * FROM accounts WHERE normalized_email = $1`,
            [email],
          );
          return {
            account: existingResult.rows[0] ? mapAccount(existingResult.rows[0]) : null,
            created: false,
            inviteValid: true,
          };
        }

        const result = await client.query(
          `INSERT INTO accounts (
             id, email, normalized_email, username, normalized_username, display_name, password_hash,
             rules_version, rules_agreed_at
           )
           VALUES ($1, $2, $2, $3, $4, $3, $5, $6, $7)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            randomUUID(), email, username, normalizedUsername, passwordHash,
            rulesVersion, rulesAgreedAt,
          ],
        );
        if (result.rows[0]) {
          const account = mapAccount(result.rows[0]);
          await client.query(
            `INSERT INTO authentication_audit_events (
               account_id, action, details, created_at
             ) VALUES ($1, 'auth.rules.agreed', $2::jsonb, $3)`,
            [account.id, JSON.stringify({ rulesVersion }), rulesAgreedAt],
          );
          if (globalTokenValid) {
            await client.query(
              `INSERT INTO authentication_audit_events (account_id, action, created_at)
               VALUES ($1, 'auth.registration_global_token.used', $2)`,
              [account.id, registeredAt],
            );
          } else {
            await client.query(
              `UPDATE registration_invites
               SET redeemed_by_account_id = $2, redeemed_at = $3
               WHERE id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
                 AND expires_at > $3`,
              [invite.id, account.id, registeredAt],
            );
            await client.query(
              `INSERT INTO authentication_audit_events (
                 account_id, action, details, created_at
               ) VALUES ($1, 'auth.registration_invite.redeemed', $2::jsonb, $3)`,
              [account.id, JSON.stringify({
                inviteId: String(invite.id),
                issuerAccountId: invite.issuer_account_id,
                issuerKind: invite.issuer_kind,
              }), registeredAt],
            );
          }
          return { account, created: true, inviteValid: true };
        }

        await client.query(
          `DELETE FROM username_reservations WHERE normalized_username = $1`,
          [normalizedUsername],
        );
        const existingResult = await client.query(
          `SELECT * FROM accounts WHERE normalized_email = $1`,
          [email],
        );
        return {
          account: existingResult.rows[0] ? mapAccount(existingResult.rows[0]) : null,
          created: false,
          inviteValid: true,
        };
      });
    },
    async createRegistrationInvite({
      actorId,
      createdAt,
      expiresAt,
      tokenLookupDigest,
      tokenSalt,
      tokenVerifier,
    }) {
      return withTransaction(async (client) => {
        const result = await client.query(
          `INSERT INTO registration_invites (
             token_lookup_digest, token_salt, token_verifier,
             issuer_kind, issuer_account_id, created_at, expires_at
           ) VALUES ($1, $2, $3, 'account', $4, $5, $6)
           RETURNING id, created_at, expires_at`,
          [tokenLookupDigest, tokenSalt, tokenVerifier, actorId, createdAt, expiresAt],
        );
        const invite = result.rows[0];
        await client.query(
          `INSERT INTO authentication_audit_events (
             account_id, action, details, created_at
           ) VALUES ($1, 'auth.registration_invite.issued', $2::jsonb, $3)`,
          [actorId, JSON.stringify({ inviteId: String(invite.id), issuerKind: 'account' }), createdAt],
        );
        return {
          createdAt: invite.created_at,
          expiresAt: invite.expires_at,
          id: String(invite.id),
        };
      });
    },
    async createSession({ accountId, csrfDigest, expiresAt, id, persistent, tokenDigest, userAgent }) {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO sessions (
             token_digest, csrf_digest, account_id, expires_at, id, last_seen_at, user_agent
           ) VALUES ($1, $2, $3, $4, $5, now(), $6)`,
          [tokenDigest, csrfDigest, accountId, expiresAt, id, userAgent],
        );
        await client.query(
          `INSERT INTO authentication_audit_events (
             account_id, session_id, action, details
           ) VALUES ($1, $2, 'auth.login.succeeded', $3::jsonb)`,
          [accountId, id, JSON.stringify({ persistent: Boolean(persistent) })],
        );
      });
    },
    async createWebAuthnChallenge({ accountId, challenge, createdAt, expiresAt, id, purpose, sessionId }) {
      await withTransaction(async (client) => {
        await client.query('DELETE FROM webauthn_challenges WHERE expires_at <= $1', [createdAt]);
        if (purpose === 'registration') {
          await client.query(
            `DELETE FROM webauthn_challenges
             WHERE purpose = 'registration' AND account_id = $1 AND session_id = $2`,
            [accountId, sessionId],
          );
        }
        await client.query(
          `INSERT INTO webauthn_challenges (
             id, challenge, purpose, account_id, session_id, created_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, challenge, purpose, accountId, sessionId, createdAt, expiresAt],
        );
      });
    },
    async claimWebAuthnChallenge({ accountId, id, now, purpose, sessionId }) {
      const result = await pool.query(
        `DELETE FROM webauthn_challenges
         WHERE id = $1
           AND purpose = $2
           AND account_id IS NOT DISTINCT FROM $3
           AND session_id IS NOT DISTINCT FROM $4
           AND expires_at > $5
         RETURNING challenge`,
        [id, purpose, accountId, sessionId, now],
      );
      return result.rows[0]?.challenge ?? null;
    },
    async createPasskey({
      accountId,
      backedUp,
      counter,
      createdAt,
      deviceType,
      id,
      idleTimeoutMs,
      label,
      publicKey,
      sessionId,
      transports,
    }) {
      return withTransaction(async (client) => {
        await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        const sessionResult = await client.query(
          `SELECT sessions.id
           FROM sessions
           JOIN accounts ON accounts.id = sessions.account_id
           WHERE sessions.id = $1
             AND sessions.account_id = $2
             AND sessions.revoked_at IS NULL
             AND sessions.expires_at > $3
             AND sessions.last_seen_at > $3 - ($4 * interval '1 millisecond')
             AND accounts.email_verified_at IS NOT NULL
             AND accounts.membership_status = 'active'
             AND accounts.force_password_change = false
             AND accounts.deleted_at IS NULL`,
          [sessionId, accountId, createdAt, idleTimeoutMs],
        );
        if (!sessionResult.rows[0]) {
          return { reason: 'session' };
        }
        const countResult = await client.query(
          'SELECT COUNT(*)::integer AS count FROM webauthn_credentials WHERE account_id = $1',
          [accountId],
        );
        if (countResult.rows[0].count >= 10) {
          return { reason: 'limit' };
        }
        const result = await client.query(
          `INSERT INTO webauthn_credentials (
             id, account_id, public_key, counter, transports, device_type,
             backed_up, label, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, label, transports, device_type, backed_up, counter,
             created_at, last_used_at`,
          [id, accountId, Buffer.from(publicKey), counter, transports, deviceType,
            backedUp, label, createdAt],
        );
        if (!result.rows[0]) {
          return { reason: 'conflict' };
        }
        await client.query(
          `INSERT INTO authentication_audit_events (
             account_id, action, details, created_at
           ) VALUES ($1, 'auth.passkey.registered', $2::jsonb, $3)`,
          [accountId, JSON.stringify({ credentialIdSuffix: id.slice(-8), label }), createdAt],
        );
        return {
          passkey: mapPasskey({ ...result.rows[0], credential_id: result.rows[0].id }),
        };
      });
    },
    async createShout(accountId, body, mentions, streamKey = 'public') {
      return withTransaction(async (client) => {
        await lockShoutSyncCursor(client);
        const result = await client.query(
          `WITH inserted AS (
             INSERT INTO shouts (account_id, body, stream_key) VALUES ($1, $2, $3)
             RETURNING id, account_id, body, created_at, updated_at, sync_cursor, stream_key
           )
            SELECT inserted.id, inserted.account_id, inserted.body, inserted.created_at,
              inserted.updated_at, inserted.sync_cursor, inserted.stream_key,
              accounts.display_name, accounts.username, accounts.role, accounts.username_color,
              accounts.username_color_effect, accounts.timestamp_color,
              accounts.visible_to_role,
              accounts.avatar_content_type, accounts.avatar_updated_at
           FROM inserted JOIN accounts ON accounts.id = inserted.account_id`,
          [accountId, body, streamKey],
        );
        const mentionAccounts = await reconcileShoutMentions(
          client,
          accountId,
          result.rows[0].id,
          mentions,
          streamKey,
        );
        const staffMentioned = await reconcileShoutStaffMention(
          client,
          accountId,
          result.rows[0].id,
          mentions,
          streamKey,
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $1, 'shout.create', 'Shout created',
             jsonb_build_object('shoutId', $2::text, 'streamKey', $3::text))`,
           [accountId, result.rows[0].id, streamKey],
        );
        return mapShout({
          ...result.rows[0],
          mention_accounts: mentionAccounts,
          staff_mentioned: staffMentioned,
        });
      });
    },
    async deleteShout(actorId, shoutId, canModerate, reason, streamKey = 'public') {
      return withTransaction(async (client) => {
        await lockShoutSyncCursor(client);
        const currentResult = await client.query(
          `SELECT shouts.*, accounts.display_name, accounts.username, accounts.role,
            accounts.username_color, accounts.username_color_effect, accounts.timestamp_color,
            accounts.visible_to_role,
            accounts.avatar_content_type, accounts.avatar_updated_at
           FROM shouts JOIN accounts ON accounts.id = shouts.account_id
           WHERE shouts.id = $1 AND shouts.deleted_at IS NULL
             AND (shouts.pinned_at IS NOT NULL OR shouts.created_at >= (
               SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $2
             ))
             AND account_visible_to($2, accounts.id)
             AND shouts.stream_key = $3
             AND shoutbox_stream_visible_to($2, $3)
           FOR UPDATE OF shouts`,
           [shoutId, actorId, streamKey],
        );
        const current = currentResult.rows[0];
        const ownsShout = current?.account_id === actorId;
        if (!current || (!ownsShout && !canModerate)) {
          return null;
        }
        if (!ownsShout && (typeof reason !== 'string' || reason.length < 3 || reason.length > 200)) {
          return { reasonRequired: true };
        }
        await client.query(
          `INSERT INTO shout_revisions (shout_id, actor_account_id, action, body, reason)
           VALUES ($1, $2, 'delete', $3, $4)`,
          [shoutId, actorId, current.body, ownsShout ? null : reason],
        );
        const deleted = await client.query(
          `UPDATE shouts SET deleted_at = now(), pinned_at = NULL, updated_at = now(),
             sync_cursor = nextval('shout_sync_cursor_sequence')
           WHERE id = $1 RETURNING sync_cursor`,
          [shoutId],
        );
        await client.query('DELETE FROM shout_mentions WHERE shout_id = $1', [shoutId]);
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'shout.delete', $3, $4::jsonb)`,
          [
            actorId,
            current.account_id,
            ownsShout ? 'Shout deleted' : reason,
            JSON.stringify({ shoutId: String(shoutId), streamKey }),
          ],
        );
        return {
          createdAt: current.created_at,
          cursor: String(deleted.rows[0].sync_cursor),
          id: String(shoutId),
          streamKey: current.stream_key ?? streamKey,
          visibleToRole: current.visible_to_role ?? null,
          wasPinned: Boolean(current.pinned_at),
        };
      });
    },
    async updateShout(
      actorId,
      shoutId,
      body,
      mentions,
      canModerate,
      reason,
      streamKey = 'public',
    ) {
      return withTransaction(async (client) => {
        await lockShoutSyncCursor(client);
        const currentResult = await client.query(
          `SELECT shouts.*, accounts.display_name, accounts.username, accounts.role,
            accounts.username_color, accounts.username_color_effect, accounts.timestamp_color,
            accounts.visible_to_role,
            accounts.avatar_content_type, accounts.avatar_updated_at
           FROM shouts JOIN accounts ON accounts.id = shouts.account_id
           WHERE shouts.id = $1 AND shouts.deleted_at IS NULL
             AND (shouts.pinned_at IS NOT NULL OR shouts.created_at >= (
               SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $2
             ))
             AND account_visible_to($2, accounts.id)
             AND shouts.stream_key = $3
             AND shoutbox_stream_visible_to($2, $3)
           FOR UPDATE OF shouts`,
           [shoutId, actorId, streamKey],
        );
        const current = currentResult.rows[0];
        const ownsShout = current?.account_id === actorId;
        if (!current || (!ownsShout && !canModerate)) {
          return null;
        }
        if (!ownsShout && (typeof reason !== 'string' || reason.length < 3 || reason.length > 200)) {
          return { reasonRequired: true };
        }
        await client.query(
          `INSERT INTO shout_revisions (shout_id, actor_account_id, action, body, reason)
           VALUES ($1, $2, 'edit', $3, $4)`,
          [shoutId, actorId, current.body, ownsShout ? null : reason],
        );
        const updated = await client.query(
          `UPDATE shouts SET body = $2, updated_at = now(),
             sync_cursor = nextval('shout_sync_cursor_sequence')
           WHERE id = $1 RETURNING sync_cursor, updated_at`,
          [shoutId, body],
        );
        const mentionAccounts = await reconcileShoutMentions(
          client,
          current.account_id,
          shoutId,
          mentions,
          streamKey,
        );
        const staffMentioned = await reconcileShoutStaffMention(
          client,
          current.account_id,
          shoutId,
          mentions,
          streamKey,
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'shout.edit', $3, $4::jsonb)`,
          [
            actorId,
            current.account_id,
            ownsShout ? 'Shout edited' : reason,
            JSON.stringify({ shoutId: String(shoutId), streamKey }),
          ],
        );
        return mapShout({
          ...current,
          body,
          mention_accounts: mentionAccounts,
          staff_mentioned: staffMentioned,
          sync_cursor: updated.rows[0].sync_cursor,
          updated_at: updated.rows[0].updated_at,
        });
      });
    },
    async setShoutPinned(actorId, shoutId, pinned, streamKey = 'public') {
      return withTransaction(async (client) => {
        await lockShoutSyncCursor(client);
        const actorResult = await client.query(
          `SELECT role FROM accounts
           WHERE id = $1 AND membership_status = 'active' AND deleted_at IS NULL
           FOR SHARE`,
          [actorId],
        );
        const actorRole = actorResult.rows[0]?.role;
        let authorized = ['admin', 'dev', 'owner'].includes(actorRole);
        if (actorRole === 'moderator') {
          const grantResult = await client.query(
            `SELECT permission FROM moderator_grants
             WHERE account_id = $1 AND permission = 'shouts.moderate'
             FOR SHARE`,
            [actorId],
          );
          authorized = grantResult.rowCount === 1;
        }
        if (!authorized) {
          return null;
        }
        const currentResult = await client.query(
          `SELECT shouts.*, accounts.display_name, accounts.username, accounts.role,
            accounts.username_color, accounts.username_color_effect, accounts.timestamp_color,
            accounts.visible_to_role,
            accounts.avatar_content_type, accounts.avatar_updated_at
           FROM shouts JOIN accounts ON accounts.id = shouts.account_id
           WHERE shouts.id = $1 AND shouts.deleted_at IS NULL
             AND shouts.created_at >= (
               SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $2
             )
             AND account_visible_to($2, accounts.id)
             AND shouts.stream_key = $3
             AND shoutbox_stream_visible_to($2, $3)
           FOR UPDATE OF shouts`,
          [shoutId, actorId, streamKey],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return null;
        }
        if (Boolean(current.pinned_at) === pinned) {
          return {
            shout: await selectShoutById(client, shoutId, actorId, streamKey),
            unchanged: true,
          };
        }
        if (pinned) {
          const countResult = await client.query(
            `SELECT count(*)::integer AS count FROM shouts
             WHERE stream_key = $1 AND deleted_at IS NULL AND pinned_at IS NOT NULL`,
            [streamKey],
          );
          if (countResult.rows[0]?.count >= maximumPinnedShoutsPerStream) {
            return { limitReached: true };
          }
        }
        const updated = await client.query(
          `UPDATE shouts
           SET pinned_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
             sync_cursor = nextval('shout_sync_cursor_sequence')
           WHERE id = $1 RETURNING pinned_at, sync_cursor`,
          [shoutId, pinned],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            actorId,
            current.account_id,
            pinned ? 'shout.pin' : 'shout.unpin',
            pinned ? 'Shout pinned' : 'Shout unpinned',
            JSON.stringify({ pinned, shoutId: String(shoutId), streamKey }),
          ],
        );
        const shout = await selectShoutById(client, shoutId, actorId, streamKey);
        if (!shout) {
          throw new Error('pinned_shout_projection_missing');
        }
        return {
          shout: {
            ...shout,
            pinnedAt: updated.rows[0].pinned_at,
            syncCursor: String(updated.rows[0].sync_cursor),
          },
          unchanged: false,
        };
      });
    },
    async createShoutFlag({ actorId, reason, shoutId, streamKey = 'public' }) {
      return withTransaction(async (client) => {
        const shoutResult = await client.query(
          `SELECT shouts.account_id, shouts.created_at, shouts.stream_key
           FROM shouts
           JOIN accounts authors ON authors.id = shouts.account_id
           WHERE shouts.id = $1
             AND shouts.deleted_at IS NULL
             AND (shouts.pinned_at IS NOT NULL OR shouts.created_at >= (
               SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $2
             ))
             AND account_visible_to($2, authors.id)
             AND shouts.stream_key = $3
             AND shoutbox_stream_visible_to($2, $3)
           FOR SHARE OF shouts`,
          [shoutId, actorId, streamKey],
        );
        const shout = shoutResult.rows[0];
        if (!shout) {
          return null;
        }
        const inserted = await client.query(
          `INSERT INTO shout_flags (shout_id, reporter_account_id, reason)
           VALUES ($1, $2, $3)
           ON CONFLICT (shout_id, reporter_account_id) DO NOTHING
           RETURNING *`,
          [shoutId, actorId, reason],
        );
        const flag = inserted.rows[0];
        if (!flag) {
          return { duplicate: true };
        }
        await client.query(
          `INSERT INTO notifications (
             account_id, message, href, shout_id, required_permission
           )
           SELECT staff.id,
             reporter.username || ' flagged a Shoutbox message',
             '/?shout=' || target_shout.id::text || '&stream=' || $3,
             target_shout.id,
             'shouts.moderate'
           FROM accounts staff
           JOIN accounts reporter ON reporter.id = $1
           JOIN shouts target_shout ON target_shout.id = $2
           WHERE staff.id <> $1
             AND staff.membership_status = 'active'
             AND staff.deleted_at IS NULL
             AND shoutbox_stream_visible_to(staff.id, 'staff')
             AND account_visible_to(staff.id, target_shout.account_id)
             AND shout_visible_to(staff.id, target_shout.id)`,
          [actorId, shoutId, streamKey],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'shout.flag', 'Shout flagged', $3::jsonb)`,
          [
            actorId,
            shout.account_id,
            JSON.stringify({ flagId: String(flag.id), shoutId: String(shoutId), streamKey }),
          ],
        );
        return { flag: mapShoutFlag(flag) };
      });
    },
    async listShoutFlags(viewerId, shoutId, limit, offset, streamKey = 'public') {
      const result = await pool.query(
        `WITH available_shout AS (
           SELECT shouts.id
           FROM shouts
           WHERE shouts.id = $1
             AND shouts.stream_key = $5
             AND shouts.deleted_at IS NULL
             AND shoutbox_stream_visible_to($2, 'staff')
             AND shoutbox_stream_visible_to($2, $5)
             AND shout_visible_to($2, shouts.id)
         )
         SELECT flags.*
         FROM available_shout
         LEFT JOIN LATERAL (
           SELECT flags.*,
             CASE WHEN reporters.id IS NULL OR account_visible_to($2, reporters.id)
               THEN reporters.username ELSE NULL END AS reporter_username,
             CASE WHEN deciders.id IS NULL OR account_visible_to($2, deciders.id)
               THEN deciders.username ELSE NULL END AS decided_by_username
           FROM shout_flags flags
           LEFT JOIN accounts reporters ON reporters.id = flags.reporter_account_id
           LEFT JOIN accounts deciders ON deciders.id = flags.decided_by_account_id
           WHERE flags.shout_id = available_shout.id
           ORDER BY (flags.status = 'open') DESC, flags.created_at DESC, flags.id DESC
           LIMIT $3 OFFSET $4
         ) flags ON true`,
        [shoutId, viewerId, limit, offset, streamKey],
      );
      if (!result.rows[0]) {
        return null;
      }
      return result.rows.filter(({ id }) => id !== null).map(mapShoutFlag);
    },
    async decideShoutFlag({ actorId, decision, expectedUpdatedAt, flagId, reason }) {
      return withTransaction(async (client) => {
        const actorResult = await client.query(
          `SELECT role FROM accounts
           WHERE id = $1 AND membership_status = 'active' AND deleted_at IS NULL
           FOR SHARE`,
          [actorId],
        );
        const actorRole = actorResult.rows[0]?.role;
        let authorized = ['admin', 'dev', 'owner'].includes(actorRole);
        if (actorRole === 'moderator') {
          const grantResult = await client.query(
            `SELECT permission FROM moderator_grants
             WHERE account_id = $1 AND permission = 'shouts.moderate'
             FOR SHARE`,
            [actorId],
          );
          authorized = grantResult.rowCount === 1;
        }
        if (!authorized) {
          return { permissionDenied: true };
        }
        const currentResult = await client.query(
          `SELECT flags.*, shouts.account_id AS shout_author_id, shouts.stream_key
           FROM shout_flags flags
           JOIN shouts ON shouts.id = flags.shout_id
           WHERE flags.id = $1
             AND shouts.deleted_at IS NULL
             AND shout_visible_to($2, shouts.id)
           FOR UPDATE OF flags`,
          [flagId, actorId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return null;
        }
        if (
          current.status !== 'open'
          || new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()
        ) {
          return { conflict: true, flag: mapShoutFlag(current) };
        }
        const updated = await client.query(
          `UPDATE shout_flags
           SET status = $2, decided_by_account_id = $3, decided_at = now(),
             decision_reason = $4, updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [flagId, decision, actorId, reason],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'shout.flag.decide', $3, $4::jsonb)`,
          [
            actorId,
            current.shout_author_id,
            reason,
            JSON.stringify({
              decision,
              flagId: String(flagId),
              shoutId: String(current.shout_id),
              streamKey: current.stream_key,
            }),
          ],
        );
        return { flag: mapShoutFlag(updated.rows[0]) };
      });
    },
    async toggleShoutReaction(accountId, shoutId, reaction, streamKey = 'public') {
      return withTransaction(async (client) => {
        await lockShoutSyncCursor(client);
        const shoutResult = await client.query(
          `SELECT shouts.id, reacting_accounts.visible_to_role AS actor_visible_to_role
           FROM shouts
           JOIN accounts ON accounts.id = shouts.account_id
           JOIN accounts reacting_accounts ON reacting_accounts.id = $2
           WHERE shouts.id = $1 AND shouts.deleted_at IS NULL
             AND (shouts.pinned_at IS NOT NULL OR shouts.created_at >= (
               SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $2
             ))
             AND account_visible_to($2, accounts.id)
             AND shouts.stream_key = $3
             AND shoutbox_stream_visible_to($2, $3)
           FOR UPDATE`,
           [shoutId, accountId, streamKey],
        );
        if (!shoutResult.rows[0]) {
          return null;
        }
        const removed = await client.query(
          `DELETE FROM shout_reactions
           WHERE shout_id = $1 AND account_id = $2 AND reaction = $3
           RETURNING reaction`,
          [shoutId, accountId, reaction],
        );
        if (!removed.rows[0]) {
          await client.query(
            `INSERT INTO shout_reactions (shout_id, account_id, reaction)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [shoutId, accountId, reaction],
          );
        }
        await client.query(
          `UPDATE shouts
           SET sync_cursor = nextval('shout_sync_cursor_sequence')
           WHERE id = $1`,
          [shoutId],
        );
        const shout = await selectShoutById(client, shoutId, accountId, streamKey);
        return shout ? {
          ...shout,
          reactionVisibleToRole: shoutResult.rows[0].actor_visible_to_role ?? null,
        } : null;
      });
    },
    async listShoutReactions(viewerId, shoutId, reaction, limit, offset) {
      const available = await pool.query(
        `SELECT 1 FROM shouts
         JOIN accounts authors ON authors.id = shouts.account_id
         WHERE shouts.id = $1 AND shouts.deleted_at IS NULL
           AND (shouts.pinned_at IS NOT NULL OR shouts.created_at >= (
             SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $2
           ))
           AND account_visible_to($2, authors.id)
           AND shout_visible_to($2, shouts.id)`,
        [shoutId, viewerId],
      );
      if (!available.rows[0]) {
        return null;
      }
      const result = await pool.query(
        `SELECT reactions.reaction, accounts.display_name, accounts.username,
          accounts.username_color, accounts.username_color_effect
         FROM shout_reactions reactions
         JOIN accounts ON accounts.id = reactions.account_id
         WHERE reactions.shout_id = $1
           AND ($2::text IS NULL OR reactions.reaction = $2)
           AND accounts.membership_status = 'active'
           AND accounts.deleted_at IS NULL
            AND account_visible_to($5, accounts.id)
         ORDER BY reactions.reaction, accounts.normalized_username, accounts.id
         LIMIT $3 OFFSET $4`,
          [shoutId, reaction, limit, offset, viewerId],
      );
      return result.rows.map((row) => ({
        displayName: row.display_name,
        reaction: row.reaction,
        username: row.username,
        usernameColor: row.username_color,
        usernameColorEffect: row.username_color_effect ?? 'none',
      }));
    },
    async countUnreadNotifications(accountId) {
      const result = await pool.query(
        `SELECT count(*)::integer AS unread_count
         FROM notifications
         WHERE account_id = $1
           AND read_at IS NULL
           AND (
             required_permission IS NULL
             OR required_permission = 'shouts.moderate'
               AND shoutbox_stream_visible_to($1, 'staff')
           )
           AND (
             forum_topic_id IS NULL
             OR forum_topic_visible_to($1, forum_topic_id)
           )
           AND (
             shout_id IS NULL
             OR shout_visible_to($1, shout_id)
           )`,
        [accountId],
      );
      return result.rows[0].unread_count;
    },
    async findAccountByEmail(email) {
      const result = await pool.query(
        `SELECT * FROM accounts WHERE normalized_email = $1`,
        [email],
      );
      return result.rows[0] ? mapAccount(result.rows[0]) : null;
    },
    async findAccountByUsername(username) {
      const result = await pool.query(
        `SELECT accounts.*, COALESCE(grants.permissions, ARRAY[]::text[]) AS permissions
         FROM accounts
         LEFT JOIN LATERAL (
           SELECT array_agg(permission ORDER BY permission) AS permissions
           FROM moderator_grants WHERE account_id = accounts.id
         ) grants ON true
         WHERE normalized_username = $1`,
        [username],
      );
      return result.rows[0] ? mapAccount(result.rows[0]) : null;
    },
    async findManagedAccount(viewerId, accountId) {
      const result = await pool.query(
        `SELECT accounts.*, COALESCE(grants.permissions, ARRAY[]::text[]) AS permissions
         FROM accounts
         LEFT JOIN LATERAL (
           SELECT array_agg(permission ORDER BY permission) AS permissions
           FROM moderator_grants WHERE account_id = accounts.id
         ) grants ON true
         WHERE accounts.id = $2
           AND account_visible_to($1, accounts.id)`,
        [viewerId, accountId],
      );
      return result.rows[0] ? mapManagedAccount(result.rows[0]) : null;
    },
    async findPublicProfileByUsername(username, viewerId) {
      const result = await pool.query(
        `SELECT accounts.id, accounts.username, accounts.display_name, accounts.description,
          accounts.location, accounts.profile_visitor_area_visible, accounts.signature, accounts.title,
          accounts.role,
          accounts.timestamp_color, accounts.username_color, accounts.username_color_effect,
          accounts.avatar_content_type, accounts.avatar_updated_at,
          accounts.created_at,
          ($2 = accounts.id OR accounts.status_and_activity_visible) AS activity_visible,
          (($2 = accounts.id OR accounts.status_and_activity_visible) AND EXISTS (
            SELECT 1 FROM sessions
            WHERE sessions.account_id = accounts.id
              AND sessions.revoked_at IS NULL
              AND sessions.expires_at > now()
              AND sessions.last_seen_at > now() - interval '10 minutes'
          )) AS online,
          count(follows.follower_account_id)::integer AS follower_count,
          EXISTS (
            SELECT 1 FROM account_follows viewer_follow
            WHERE viewer_follow.follower_account_id = $2
              AND viewer_follow.followed_account_id = accounts.id
          ) AS followed_by_viewer
         FROM accounts
         LEFT JOIN account_follows follows ON follows.followed_account_id = accounts.id
           AND account_visible_to($2, follows.follower_account_id)
           AND EXISTS (
             SELECT 1 FROM accounts counted_followers
             WHERE counted_followers.id = follows.follower_account_id
               AND counted_followers.membership_status = 'active'
               AND counted_followers.deleted_at IS NULL
           )
         WHERE (
             accounts.normalized_username = $1
             OR EXISTS (
               SELECT 1 FROM account_username_history username_history
               WHERE username_history.account_id = accounts.id
                 AND username_history.normalized_username = $1
             )
           )
           AND accounts.membership_status = 'active'
           AND accounts.deleted_at IS NULL
           AND account_visible_to($2, accounts.id)
         GROUP BY accounts.id`,
        [username, viewerId],
      );
      return result.rows[0] ? mapPublicProfile(result.rows[0]) : null;
    },
    async listProfileFollowers(viewerId, profileId, limit, offset) {
      const result = await pool.query(
        `SELECT followers.id, followers.username, followers.display_name,
          followers.avatar_content_type, followers.avatar_updated_at
         FROM account_follows follows
         JOIN accounts followers ON followers.id = follows.follower_account_id
         WHERE follows.followed_account_id = $2
           AND followers.membership_status = 'active'
           AND followers.deleted_at IS NULL
           AND account_visible_to($1, followers.id)
         ORDER BY follows.created_at DESC, followers.id
         LIMIT $3 OFFSET $4`,
        [viewerId, profileId, limit, offset],
      );
      return result.rows.map(mapProfileFollower);
    },
    async searchActiveUsernamesByPrefix(prefix, viewerId, limit) {
      const result = await pool.query(
        `SELECT username FROM accounts
         WHERE normalized_username COLLATE "C" LIKE $1 ESCAPE E'\\\\'
           AND id <> $2
           AND membership_status = 'active'
           AND deleted_at IS NULL
           AND account_visible_to($2, id)
         ORDER BY normalized_username COLLATE "C", id
         LIMIT $3`,
        [`${escapeLikePattern(prefix)}%`, viewerId, limit],
      );
      return result.rows.map(({ username }) => username);
    },
    async listOnlineMembers(viewerId, limit) {
      const result = await pool.query(
        `SELECT accounts.username, max(sessions.last_seen_at) AS last_seen_at
         FROM accounts
         JOIN sessions ON sessions.account_id = accounts.id
         WHERE sessions.revoked_at IS NULL
           AND sessions.expires_at > now()
           AND sessions.last_seen_at > now() - interval '10 minutes'
           AND accounts.membership_status = 'active'
           AND accounts.deleted_at IS NULL
           AND ($1 = accounts.id OR accounts.status_and_activity_visible)
           AND account_visible_to($1, accounts.id)
         GROUP BY accounts.id, accounts.username
         ORDER BY max(sessions.last_seen_at) DESC, accounts.username
         LIMIT $2`,
        [viewerId, limit],
      );
      return result.rows.map((row) => ({
        lastSeenAt: row.last_seen_at,
        username: row.username,
      }));
    },
    async findSession(tokenDigest, now, idleTimeoutMs) {
      const result = await pool.query(
        `SELECT sessions.id AS session_id, sessions.csrf_digest, sessions.last_seen_at,
          accounts.*,
          COALESCE(grants.permissions, ARRAY[]::text[]) AS permissions
         FROM sessions JOIN accounts ON accounts.id = sessions.account_id
         LEFT JOIN LATERAL (
           SELECT array_agg(permission ORDER BY permission) AS permissions
           FROM moderator_grants WHERE account_id = accounts.id
         ) grants ON true
         WHERE sessions.token_digest = $1
           AND sessions.revoked_at IS NULL
           AND sessions.expires_at > $2
           AND sessions.last_seen_at > $2 - ($3 * interval '1 millisecond')
           AND accounts.membership_status = 'active'
           AND accounts.force_password_change = false`,
        [tokenDigest, now, idleTimeoutMs],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      if (now.getTime() - new Date(row.last_seen_at).getTime() >= 5 * 60 * 1000) {
        await pool.query(
          `UPDATE sessions SET last_seen_at = $2
           WHERE token_digest = $1 AND revoked_at IS NULL`,
          [tokenDigest, now],
        );
      }
      return { account: mapAccount(row), csrfDigest: row.csrf_digest, id: row.session_id };
    },
    async findPasskeyByCredentialId(credentialId) {
      const result = await pool.query(
        `SELECT accounts.*,
          credentials.id AS credential_id, credentials.public_key,
          credentials.counter, credentials.transports, credentials.device_type,
          credentials.backed_up, credentials.label,
          credentials.created_at AS credential_created_at, credentials.last_used_at,
          COALESCE(grants.permissions, ARRAY[]::text[]) AS permissions
         FROM webauthn_credentials credentials
         JOIN accounts ON accounts.id = credentials.account_id
         LEFT JOIN LATERAL (
           SELECT array_agg(permission ORDER BY permission) AS permissions
           FROM moderator_grants WHERE account_id = accounts.id
         ) grants ON true
         WHERE credentials.id = $1`,
        [credentialId],
      );
      const row = result.rows[0];
      return row ? { account: mapAccount(row), passkey: mapPasskey(row) } : null;
    },
    async listPasskeys(accountId) {
      const result = await pool.query(
        `SELECT id AS credential_id, label, transports, device_type, backed_up,
          counter, created_at AS credential_created_at, last_used_at
         FROM webauthn_credentials
         WHERE account_id = $1
         ORDER BY created_at DESC, id`,
        [accountId],
      );
      return result.rows.map(mapPasskey);
    },
    async completePasskeyLogin({
      accountId,
      backedUp,
      credentialId,
      csrfDigest,
      expiresAt,
      deviceType,
      expectedCounter,
      newCounter,
      persistent,
      sessionId,
      tokenDigest,
      usedAt,
      userAgent,
    }) {
      return withTransaction(async (client) => {
        await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        const credentialResult = await client.query(
          `UPDATE webauthn_credentials credentials
           SET counter = $3, last_used_at = $4, backed_up = $6, device_type = $7
           FROM accounts
           WHERE credentials.id = $1
             AND credentials.account_id = $2
             AND credentials.counter = $5
             AND accounts.id = credentials.account_id
             AND accounts.email_verified_at IS NOT NULL
             AND accounts.membership_status = 'active'
             AND accounts.force_password_change = false
             AND accounts.deleted_at IS NULL
           RETURNING credentials.id`,
          [credentialId, accountId, newCounter, usedAt, expectedCounter, backedUp, deviceType],
        );
        if (!credentialResult.rows[0]) {
          return false;
        }
        await client.query(
          `INSERT INTO sessions (
             token_digest, csrf_digest, account_id, expires_at, id, last_seen_at, user_agent,
             authentication_method, passkey_credential_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'passkey', $8)`,
          [tokenDigest, csrfDigest, accountId, expiresAt, sessionId, usedAt, userAgent,
            credentialId],
        );
        await client.query(
          `INSERT INTO authentication_audit_events (
             account_id, session_id, action, details, created_at
           ) VALUES ($1, $2, 'auth.login.succeeded', $3::jsonb, $4)`,
          [accountId, sessionId, JSON.stringify({ method: 'passkey', persistent }), usedAt],
        );
        return true;
      });
    },
    async listSessions(accountId, currentSessionId, now, idleTimeoutMs) {
      const result = await pool.query(
        `SELECT id, created_at, last_seen_at, expires_at, user_agent, id = $2 AS current
         FROM sessions
         WHERE account_id = $1
           AND revoked_at IS NULL
           AND expires_at > $3
           AND last_seen_at > $3 - ($4 * interval '1 millisecond')
         ORDER BY current DESC, last_seen_at DESC, id`,
        [accountId, currentSessionId, now, idleTimeoutMs],
      );
      return result.rows.map(mapSession);
    },
    async listNotifications(accountId, limit, offset = 0) {
      const result = await pool.query(
        `SELECT notifications.id, notifications.message,
           CASE WHEN notifications.shout_id IS NOT NULL
               AND notifications.href = '/'
             THEN '/?shout=' || notifications.shout_id::text
               || '&stream=' || shouts.stream_key
             ELSE notifications.href END AS href,
           notifications.read_at, notifications.created_at
         FROM notifications
         LEFT JOIN shouts ON shouts.id = notifications.shout_id
         WHERE notifications.account_id = $1
           AND (
             notifications.required_permission IS NULL
             OR notifications.required_permission = 'shouts.moderate'
               AND shoutbox_stream_visible_to($1, 'staff')
           )
           AND (
             notifications.forum_topic_id IS NULL
             OR forum_topic_visible_to($1, notifications.forum_topic_id)
           )
           AND (
             notifications.shout_id IS NULL
             OR shout_visible_to($1, notifications.shout_id)
           )
         ORDER BY notifications.created_at DESC LIMIT $2 OFFSET $3`,
        [accountId, limit, offset],
      );
      return result.rows.map(mapNotification);
    },
    async listAccountAudit(viewerId, accountId, limit, offset) {
      const result = await pool.query(
        `SELECT id, actor_account_id, target_account_id, action, reason, details, created_at
         FROM moderation_audit_events
         WHERE target_account_id = $2
           AND account_visible_to($1, target_account_id)
           AND (
             actor_account_id IS NULL
             OR account_visible_to($1, actor_account_id)
           )
         ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [viewerId, accountId, limit, offset],
      );
      return result.rows.map(mapAuditEvent);
    },
    async listDeletedAccountHistory(viewerId, limit, offset) {
      const result = await pool.query(
        `SELECT id, actor_account_id, target_account_id, action, reason, details, created_at
         FROM moderation_audit_events
         WHERE action = 'account.delete'
           AND account_visible_to($1, target_account_id)
           AND (
             actor_account_id IS NULL
             OR account_visible_to($1, actor_account_id)
           )
         ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [viewerId, limit, offset],
      );
      return result.rows.map(mapAuditEvent);
    },
    async listAuthenticationAudit(viewerId, limit, offset) {
      const result = await pool.query(
        `SELECT id, account_id, action, details, created_at
         FROM authentication_audit_events
         WHERE account_id IS NULL OR account_visible_to($1, account_id)
         ORDER BY id DESC LIMIT $2 OFFSET $3`,
        [viewerId, limit, offset],
      );
      return result.rows.map(mapAuthenticationAuditEvent);
    },
    async listManagedAccounts(viewerId, limit, offset) {
      const result = await pool.query(
        `SELECT accounts.*, COALESCE(grants.permissions, ARRAY[]::text[]) AS permissions
         FROM accounts
         LEFT JOIN LATERAL (
           SELECT array_agg(permission ORDER BY permission) AS permissions
           FROM moderator_grants WHERE account_id = accounts.id
         ) grants ON true
         WHERE accounts.deleted_at IS NULL
           AND account_visible_to($1, accounts.id)
         ORDER BY accounts.created_at DESC, accounts.id DESC LIMIT $2 OFFSET $3`,
        [viewerId, limit, offset],
      );
      return result.rows.map(mapManagedAccount);
    },
    async countManagedAccounts(viewerId) {
      const result = await pool.query(
        `SELECT count(*)::integer AS count
         FROM accounts
         WHERE accounts.deleted_at IS NULL
           AND account_visible_to($1, accounts.id)`,
        [viewerId],
      );
      return result.rows[0].count;
    },
    async createUsernameRenameRequest({
      accountId,
      normalizedUsername,
      requestedAt,
      username,
      weeklyWindowMs,
    }) {
      return withTransaction(async (client) => {
        const accountResult = await client.query(
          `SELECT id, username, normalized_username, membership_status, deleted_at
           FROM accounts WHERE id = $1 FOR UPDATE`,
          [accountId],
        );
        const account = accountResult.rows[0];
        if (
          !account
          || account.membership_status !== 'active'
          || account.deleted_at
        ) {
          return { status: 'account_unavailable' };
        }
        if (account.normalized_username === normalizedUsername) {
          return { status: 'unchanged' };
        }

        const recentResult = await client.query(
          `SELECT requested_at, status
           FROM username_rename_requests
           WHERE account_id = $1
           ORDER BY requested_at DESC, id DESC
           LIMIT 1`,
          [accountId],
        );
        const recent = recentResult.rows[0];
        if (recent?.status === 'pending') {
          return { requestPending: true, status: 'pending' };
        }
        if (
          recent
          && new Date(recent.requested_at).getTime() > requestedAt.getTime() - weeklyWindowMs
        ) {
          return {
            retryAt: new Date(new Date(recent.requested_at).getTime() + weeklyWindowMs),
            status: 'cooldown',
          };
        }

        const reservationResult = await client.query(
          `INSERT INTO username_reservations (normalized_username)
           VALUES ($1) ON CONFLICT DO NOTHING RETURNING normalized_username`,
          [normalizedUsername],
        );
        if (!reservationResult.rows[0]) {
          return { status: 'unavailable' };
        }

        const requestResult = await client.query(
          `INSERT INTO username_rename_requests (
             account_id, current_username, requested_username,
             normalized_requested_username, requested_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $5)
           RETURNING *`,
          [accountId, account.username, username, normalizedUsername, requestedAt],
        );
        const request = requestResult.rows[0];
        await client.query(
          `UPDATE username_reservations
           SET rename_request_id = $2
           WHERE normalized_username = $1`,
          [normalizedUsername, request.id],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details, created_at
           ) VALUES (
             $1, $1, 'account.username_rename.requested',
             'Username rename requested', $2::jsonb, $3
           )`,
          [accountId, JSON.stringify({
            from: account.username,
            requestId: String(request.id),
            to: username,
          }), requestedAt],
        );
        return { request: mapUsernameRenameRequest(request), status: 'created' };
      });
    },
    async listOwnUsernameRenameRequests(accountId, limit, offset) {
      const result = await pool.query(
        `SELECT * FROM username_rename_requests
         WHERE account_id = $1
         ORDER BY requested_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [accountId, limit, offset],
      );
      return result.rows.map(mapUsernameRenameRequest);
    },
    async listUsernameRenameRequests(viewerId, limit, offset) {
      const result = await pool.query(
        `SELECT requests.*, accounts.username AS account_username,
           accounts.role AS account_role
         FROM username_rename_requests requests
         JOIN accounts ON accounts.id = requests.account_id
         WHERE requests.status = 'pending'
           AND accounts.deleted_at IS NULL
           AND account_visible_to($1, accounts.id)
         ORDER BY requests.requested_at ASC, requests.id ASC
         LIMIT $2 OFFSET $3`,
        [viewerId, limit, offset],
      );
      return result.rows.map(mapUsernameRenameRequest);
    },
    async decideUsernameRenameRequest({
      actorId,
      decidedAt,
      decision,
      expectedUpdatedAt,
      reason,
      requestId,
    }) {
      return withTransaction(async (client) => {
        const accountLockResult = await client.query(
          `SELECT accounts.id, accounts.role, accounts.membership_status,
             accounts.deleted_at,
             EXISTS (
               SELECT 1 FROM moderator_grants
               WHERE moderator_grants.account_id = accounts.id
                 AND moderator_grants.permission = 'users.moderate'
             ) AS users_moderate
           FROM accounts
           WHERE accounts.id = $1
             OR accounts.id = (
               SELECT account_id FROM username_rename_requests WHERE id = $2
             )
           ORDER BY accounts.id
           FOR UPDATE OF accounts`,
          [actorId, requestId],
        );
        const actor = accountLockResult.rows.find(({ id }) => id === actorId);
        if (
          !actor
          || actor.membership_status !== 'active'
          || actor.deleted_at
          || !(
            ['admin', 'dev', 'owner'].includes(actor.role)
            || (actor.role === 'moderator' && actor.users_moderate)
          )
        ) {
          return { status: 'permission_denied' };
        }
        const requestResult = await client.query(
          `SELECT requests.*, accounts.username AS account_username,
             accounts.normalized_username AS account_normalized_username,
             accounts.created_at AS account_created_at,
             accounts.force_password_change AS account_force_password_change,
             accounts.membership_status AS account_membership_status,
             accounts.deleted_at AS account_deleted_at,
             accounts.role AS account_role
           FROM username_rename_requests requests
           JOIN accounts ON accounts.id = requests.account_id
           WHERE requests.id = $2 AND account_visible_to($1, accounts.id)
           FOR UPDATE OF requests`,
          [actorId, requestId],
        );
        const request = requestResult.rows[0];
        if (!request) {
          return { status: 'not_found' };
        }
        if (
          request.account_id === actorId
          || (actor.role === 'moderator' && request.account_role !== 'member')
        ) {
          return { status: 'denied' };
        }
        if (
          request.status !== 'pending'
          || new Date(request.updated_at).getTime() !== expectedUpdatedAt.getTime()
          || request.account_deleted_at
          || request.account_username !== request.current_username
          || (
            decision === 'approved'
            && (
              request.account_membership_status !== 'active'
              || request.account_force_password_change
            )
          )
        ) {
          return { status: 'conflict' };
        }

        if (decision === 'approved') {
          const reservationResult = await client.query(
            `SELECT normalized_username FROM username_reservations
             WHERE normalized_username = $1 AND rename_request_id = $2
             FOR UPDATE`,
            [request.normalized_requested_username, request.id],
          );
          if (!reservationResult.rows[0]) {
            return { status: 'conflict' };
          }
          const identityStartResult = await client.query(
            `SELECT COALESCE(max(ended_at), $2) AS started_at
             FROM account_username_history WHERE account_id = $1`,
            [request.account_id, request.account_created_at],
          );
          await client.query(
            `INSERT INTO account_username_history (
               account_id, username, normalized_username,
               started_at, ended_at, rename_request_id
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              request.account_id,
              request.account_username,
              request.account_normalized_username,
              identityStartResult.rows[0].started_at,
              decidedAt,
              request.id,
            ],
          );
          await client.query(
            `UPDATE accounts
             SET username = $2, normalized_username = $3, display_name = $2, updated_at = $4
             WHERE id = $1`,
            [
              request.account_id,
              request.requested_username,
              request.normalized_requested_username,
              decidedAt,
            ],
          );
        } else {
          await client.query(
            `DELETE FROM username_reservations reservations
             WHERE reservations.normalized_username = $1
               AND reservations.rename_request_id = $2
               AND NOT EXISTS (
                 SELECT 1 FROM accounts
                 WHERE accounts.normalized_username = reservations.normalized_username
               )
               AND NOT EXISTS (
                 SELECT 1 FROM account_username_history history
                 WHERE history.normalized_username = reservations.normalized_username
               )`,
            [request.normalized_requested_username, request.id],
          );
        }

        const updatedResult = await client.query(
          `UPDATE username_rename_requests
           SET status = $2, decided_at = $3, decided_by_account_id = $4,
             decision_reason = $5, updated_at = $3
           WHERE id = $1
           RETURNING *`,
          [request.id, decision, decidedAt, actorId, reason],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details, created_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            actorId,
            request.account_id,
            `account.username_rename.${decision}`,
            reason,
            JSON.stringify({
              from: request.current_username,
              requestId: String(request.id),
              to: request.requested_username,
            }),
            decidedAt,
          ],
        );
        await client.query(
          `INSERT INTO notifications (account_id, message, href, created_at)
           VALUES ($1, $2, '/profile?tab=settings', $3)`,
          [
            request.account_id,
            decision === 'approved'
              ? `Your username was changed to ${request.requested_username}.`
              : `Your username rename to ${request.requested_username} was rejected.`,
            decidedAt,
          ],
        );
        return {
          request: mapUsernameRenameRequest({
            ...updatedResult.rows[0],
            account_role: request.account_role,
            account_username: decision === 'approved'
              ? request.requested_username
              : request.account_username,
          }),
          status: decision,
        };
      });
    },
    async clearAccountAvatar({ actorId, expectedUpdatedAt, reason, targetId, updatedAt }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT * FROM accounts WHERE id = $1 FOR UPDATE`,
          [targetId],
        );
        const current = currentResult.rows[0];
        if (!current || new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return { account: null };
        }

        await client.query(
          `UPDATE accounts
           SET avatar_content_type = NULL, avatar_data = NULL, avatar_updated_at = NULL,
             updated_at = $2
           WHERE id = $1`,
          [targetId, updatedAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'account.avatar.remove', $3, $4::jsonb)`,
          [actorId, targetId, reason, JSON.stringify({
            after: { hasAvatar: false },
            before: { hasAvatar: Boolean(current.avatar_updated_at) },
          })],
        );

        const updatedResult = await client.query(
          `SELECT accounts.*, COALESCE(grants.permissions, ARRAY[]::text[]) AS permissions
           FROM accounts
           LEFT JOIN LATERAL (
             SELECT array_agg(permission ORDER BY permission) AS permissions
             FROM moderator_grants WHERE account_id = accounts.id
           ) grants ON true
           WHERE accounts.id = $1`,
          [targetId],
        );
        return { account: mapManagedAccount(updatedResult.rows[0]) };
      });
    },
    async getSiteSettings() {
      const result = await pool.query(
      `SELECT access_block_reason, access_blocked,
        global_registration_token_enabled
          AND global_registration_token_expires_at > now()
          AS global_registration_token_enabled,
        global_registration_token_lookup_digest IS NOT NULL
          AS global_registration_token_configured,
        global_registration_token_expires_at, global_registration_token_issued_at,
        presence_counter_enabled,
        shoutbox_visibility_count,
                shoutbox_visibility_hours, shoutbox_visibility_mode, updated_at
         FROM site_settings WHERE singleton = true`,
      );
      if (!result.rows[0]) {
        throw new Error('site_settings_missing');
      }
      return mapSiteSettings(result.rows[0]);
    },
    async setSiteAccessBlock({ actorId, blocked, expectedUpdatedAt, reason, updatedAt }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT access_block_reason, access_blocked,
             global_registration_token_enabled,
             global_registration_token_lookup_digest,
             global_registration_token_expires_at, global_registration_token_issued_at,
             presence_counter_enabled, shoutbox_visibility_count,
             shoutbox_visibility_hours, shoutbox_visibility_mode, updated_at
           FROM site_settings WHERE singleton = true FOR UPDATE`,
        );
        const current = currentResult.rows[0];
        if (!current) {
          throw new Error('site_settings_missing');
        }
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return null;
        }
        const nextReason = blocked ? reason : null;
        if (
          current.access_blocked === blocked
          && current.access_block_reason === nextReason
        ) {
          return mapSiteSettings(current);
        }
        const updatedResult = await client.query(
          `UPDATE site_settings
           SET access_blocked = $1, access_block_reason = $2, updated_at = $3
           WHERE singleton = true
           RETURNING access_block_reason, access_blocked,
             global_registration_token_enabled,
             global_registration_token_lookup_digest IS NOT NULL
               AS global_registration_token_configured,
             global_registration_token_expires_at, global_registration_token_issued_at,
             presence_counter_enabled, shoutbox_visibility_count,
             shoutbox_visibility_hours, shoutbox_visibility_mode, updated_at`,
          [blocked, nextReason, updatedAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, NULL, $2, $3, $4::jsonb)`,
          [
            actorId,
            blocked ? 'site.access_block.enable' : 'site.access_block.disable',
            blocked ? 'Site access block enabled' : 'Site access block disabled',
            JSON.stringify({
              after: { blocked, reasonLength: nextReason?.length ?? 0 },
              before: {
                blocked: current.access_blocked,
                reasonLength: current.access_block_reason?.length ?? 0,
              },
            }),
          ],
        );
        return mapSiteSettings(updatedResult.rows[0]);
      });
    },
    async revokeAllRegistrationTokens({ actorId, expectedUpdatedAt, revokedAt }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT global_registration_token_enabled,
             global_registration_token_lookup_digest,
             global_registration_token_expires_at, global_registration_token_issued_at,
             presence_counter_enabled, shoutbox_visibility_count,
             shoutbox_visibility_hours, shoutbox_visibility_mode, updated_at
           FROM site_settings WHERE singleton = true FOR UPDATE`,
        );
        const current = currentResult.rows[0];
        if (!current) {
          throw new Error('site_settings_missing');
        }
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return null;
        }
        const inviteResult = await client.query(
          `UPDATE registration_invites
           SET revoked_at = $1
           WHERE redeemed_at IS NULL AND revoked_at IS NULL
           RETURNING id`,
          [revokedAt],
        );
        const updatedResult = await client.query(
          `UPDATE site_settings
           SET global_registration_token_enabled = false,
             global_registration_token_lookup_digest = NULL,
             global_registration_token_salt = NULL,
             global_registration_token_verifier = NULL,
             global_registration_token_issued_at = NULL,
             global_registration_token_expires_at = NULL,
             updated_at = $1
           WHERE singleton = true
           RETURNING global_registration_token_enabled,
             false AS global_registration_token_configured,
             global_registration_token_expires_at, global_registration_token_issued_at,
             presence_counter_enabled, shoutbox_visibility_count,
             shoutbox_visibility_hours, shoutbox_visibility_mode, updated_at`,
          [revokedAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, NULL, 'site.registration_tokens.revoke_all',
             'All registration tokens revoked', $2::jsonb)`,
          [actorId, JSON.stringify({
            globalTokenConfigured: current.global_registration_token_lookup_digest !== null,
            globalTokenEnabled: current.global_registration_token_enabled,
            revokedInviteCount: inviteResult.rowCount,
          })],
        );
        return {
          revokedInviteCount: inviteResult.rowCount,
          settings: mapSiteSettings(updatedResult.rows[0]),
        };
      });
    },
    async updateSiteSettings({
      actorId,
      expectedUpdatedAt,
      globalRegistrationTokenEnabled,
      presenceCounterEnabled,
      reason,
      shoutboxVisibilityCount,
      shoutboxVisibilityHours,
      shoutboxVisibilityMode,
      updatedAt,
    }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
            `SELECT global_registration_token_enabled,
              global_registration_token_lookup_digest,
              global_registration_token_expires_at, global_registration_token_issued_at,
              presence_counter_enabled,
              shoutbox_visibility_count,
              shoutbox_visibility_hours, shoutbox_visibility_mode, updated_at
           FROM site_settings WHERE singleton = true FOR UPDATE`,
        );
        const current = currentResult.rows[0];
        if (!current) {
          throw new Error('site_settings_missing');
        }
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return null;
        }
        if (
          globalRegistrationTokenEnabled
          && (
            current.global_registration_token_lookup_digest === null
            || new Date(current.global_registration_token_expires_at).getTime()
              <= updatedAt.getTime()
          )
        ) {
          return { globalTokenMissing: true };
        }
        const nextVisibilityCount = shoutboxVisibilityCount
          ?? current.shoutbox_visibility_count;
        const nextVisibilityHours = shoutboxVisibilityHours
          ?? current.shoutbox_visibility_hours;
        if (
          current.global_registration_token_enabled === globalRegistrationTokenEnabled
          && current.presence_counter_enabled === presenceCounterEnabled
          && current.shoutbox_visibility_count === nextVisibilityCount
          && current.shoutbox_visibility_hours === nextVisibilityHours
          && current.shoutbox_visibility_mode === shoutboxVisibilityMode
        ) {
          return mapSiteSettings(current);
        }
        const updatedResult = await client.query(
          `UPDATE site_settings
           SET global_registration_token_enabled = $1, presence_counter_enabled = $2,
               shoutbox_visibility_count = $3, shoutbox_visibility_hours = $4,
               shoutbox_visibility_mode = $5, updated_at = $6
           WHERE singleton = true
           RETURNING global_registration_token_enabled,
                     global_registration_token_lookup_digest IS NOT NULL
                       AS global_registration_token_configured,
                     global_registration_token_expires_at,
                     global_registration_token_issued_at,
                     presence_counter_enabled,
                     shoutbox_visibility_count,
                     shoutbox_visibility_hours, shoutbox_visibility_mode, updated_at`,
          [
            globalRegistrationTokenEnabled,
            presenceCounterEnabled,
            nextVisibilityCount,
            nextVisibilityHours,
            shoutboxVisibilityMode,
            updatedAt,
          ],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, NULL, $2, $3, $4::jsonb)`,
          [actorId, 'site.settings.update', reason, JSON.stringify({
            after: {
              globalRegistrationTokenEnabled,
              presenceCounterEnabled,
              shoutboxVisibilityCount: nextVisibilityCount,
              shoutboxVisibilityHours: nextVisibilityHours,
              shoutboxVisibilityMode,
            },
            before: {
              globalRegistrationTokenEnabled: current.global_registration_token_enabled,
              presenceCounterEnabled: current.presence_counter_enabled,
              shoutboxVisibilityCount: current.shoutbox_visibility_count,
              shoutboxVisibilityHours: current.shoutbox_visibility_hours,
              shoutboxVisibilityMode: current.shoutbox_visibility_mode,
            },
          })],
        );
        return mapSiteSettings(updatedResult.rows[0]);
      });
    },
    async recordServerDiagnostic({ action, actorId, createdAt, details, reason }) {
      await pool.query(
        `INSERT INTO moderation_audit_events (
           actor_account_id, target_account_id, action, reason, details, created_at
         ) VALUES ($1, NULL, $2, $3, $4::jsonb, $5)`,
        [actorId, action, reason, JSON.stringify(details), createdAt],
      );
    },
    async recordServerRestart({ actorId, createdAt, minimumIntervalMs, reason }) {
      return withTransaction(async (client) => {
        const lock = await client.query(
          'SELECT pg_try_advisory_xact_lock($1) AS locked',
          [serverRestartLockId],
        );
        if (!lock.rows[0]?.locked) {
          return { status: 'busy' };
        }
        const previous = await client.query(
          `SELECT created_at
           FROM moderation_audit_events
           WHERE action = 'server.restart.requested'
           ORDER BY created_at DESC
           LIMIT 1`,
        );
        const retryAfterMs = previous.rows[0]
          ? Math.max(
            0,
            minimumIntervalMs - (createdAt.getTime() - previous.rows[0].created_at.getTime()),
          )
          : 0;
        if (retryAfterMs > 0) {
          return { retryAfterMs, status: 'cooldown' };
        }
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details, created_at
           ) VALUES ($1, NULL, 'server.restart.requested', $2, '{}'::jsonb, $3)`,
          [actorId, reason, createdAt],
        );
        return { status: 'recorded' };
      });
    },
    async runShoutboxDiagnostic({ actorId, createdAt, loadLimit, writeCount }) {
      return withTransaction(async (client) => {
        if (!await prepareServerDiagnostic(client)) {
          return null;
        }
        await client.query('SAVEPOINT server_diagnostic_work');
        const inserted = await client.query(
          `INSERT INTO shouts (account_id, body)
           SELECT $1, '[Diagnostic] transient Shoutbox load ' || sequence
           FROM generate_series(1, $2) sequence
           RETURNING id`,
          [actorId, writeCount],
        );
        const loaded = await selectShouts(client, loadLimit, actorId);
        await client.query('ROLLBACK TO SAVEPOINT server_diagnostic_work');
        await client.query('RELEASE SAVEPOINT server_diagnostic_work');
        const result = {
          broadcasted: 0,
          loaded: loaded.length,
          persisted: 0,
          written: inserted.rows.length,
        };
        await insertServerDiagnosticAudit(client, {
          action: 'diagnostic.shoutbox.write_load',
          actorId,
          createdAt,
          details: result,
          reason: 'Shoutbox write and load diagnostic run',
        });
        return result;
      });
    },
    async runNotificationPushDiagnostic({ actorId, createdAt, notificationCount }) {
      return withTransaction(async (client) => {
        if (!await prepareServerDiagnostic(client)) {
          return null;
        }
        const inserted = await client.query(
          `INSERT INTO notifications (account_id, message, href, created_at)
           SELECT $1, '[Diagnostic] notification push ' || sequence || ' of ' || $2,
             '/notifications', $3
           FROM generate_series(1, $2) sequence
           RETURNING id`,
          [actorId, notificationCount, createdAt],
        );
        const ids = inserted.rows.map((row) => String(row.id));
        const deliveries = await client.query(
          `SELECT count(*)::integer AS count
           FROM web_push_deliveries
           WHERE notification_id = ANY($1::bigint[])`,
          [ids],
        );
        const result = {
          notificationCount: inserted.rows.length,
          queuedDeliveries: deliveries.rows[0]?.count ?? 0,
        };
        await insertServerDiagnosticAudit(client, {
          action: 'diagnostic.notification_push',
          actorId,
          createdAt,
          details: result,
          reason: 'Notification push diagnostic run',
        });
        return result;
      });
    },
    async listShouts(limit, viewerId = null, streamKey = 'public') {
      return selectShouts(pool, limit, viewerId, null, streamKey);
    },
    async getShoutboxCursor(streamKey = 'public', viewerId = null) {
      const result = await pool.query(
        `SELECT COALESCE(MAX(sync_cursor), 0) AS cursor FROM shouts
         WHERE stream_key = $1
           AND shoutbox_stream_visible_to($2, $1)`,
        [streamKey, viewerId],
      );
      return String(result.rows[0].cursor);
    },
    async getShoutboxSnapshot(limit, viewerId = null, streamKey = 'public') {
      return withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const cursorResult = await client.query(
          `SELECT COALESCE(MAX(sync_cursor), 0) AS cursor FROM shouts
           WHERE stream_key = $1
             AND shoutbox_stream_visible_to($2, $1)`,
          [streamKey, viewerId],
        );
        const settingsResult = await client.query(
          `SELECT shoutbox_visibility_count, shoutbox_visibility_hours,
                  shoutbox_visibility_mode
           FROM site_settings WHERE singleton = true`,
        );
        const settings = settingsResult.rows[0];
        if (!settings) {
          throw new Error('site_settings_missing');
        }
        const visibility = {
          count: settings.shoutbox_visibility_count,
          hours: settings.shoutbox_visibility_hours,
          mode: settings.shoutbox_visibility_mode,
        };
        const page = await selectShoutHistoryPage(client, {
          historyCount: visibility.mode === 'count' ? visibility.count : null,
          historyHours: visibility.mode === 'time' ? visibility.hours : null,
          limit,
          streamKey,
          viewerId,
        });
        const pinned = await selectPinnedShouts(client, viewerId, streamKey);
        return {
          cursor: String(cursorResult.rows[0].cursor),
          pinned,
          ...page,
          visibility,
        };
      });
    },
    async getShoutboxHistoryPage(before, limit, viewerId = null, streamKey = 'public') {
      return withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const settingsResult = await client.query(
          `SELECT shoutbox_visibility_count, shoutbox_visibility_hours,
                  shoutbox_visibility_mode
           FROM site_settings WHERE singleton = true`,
        );
        const settings = settingsResult.rows[0];
        if (!settings) {
          throw new Error('site_settings_missing');
        }
        return selectShoutHistoryPage(client, {
          before,
          historyCount: settings.shoutbox_visibility_mode === 'count'
            ? settings.shoutbox_visibility_count
            : null,
          historyHours: settings.shoutbox_visibility_mode === 'time'
            ? settings.shoutbox_visibility_hours
            : null,
          limit,
          streamKey,
          viewerId,
        });
      });
    },
    async locateRetainedShout(viewerId, shoutId, streamKey = 'public') {
      return withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const settingsResult = await client.query(
          `SELECT shoutbox_visibility_count, shoutbox_visibility_hours,
                  shoutbox_visibility_mode
           FROM site_settings WHERE singleton = true`,
        );
        const settings = settingsResult.rows[0];
        if (!settings) {
          throw new Error('site_settings_missing');
        }
        const result = await client.query(
          `WITH retained_shouts AS MATERIALIZED (
             SELECT shouts.id, shouts.created_at
             FROM shouts JOIN accounts ON accounts.id = shouts.account_id
             WHERE shouts.deleted_at IS NULL
               AND account_visible_to($1, accounts.id)
               AND shouts.stream_key = $4
               AND shoutbox_stream_visible_to($1, $4)
               AND shouts.created_at >= (
                 SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $1
               )
               AND ($2::integer IS NULL OR shouts.created_at >= now() - ($2 * interval '1 hour'))
             ORDER BY shouts.created_at DESC, shouts.id DESC
             LIMIT $3
           ), target AS (
             SELECT id, created_at FROM retained_shouts WHERE id = $5
           )
           SELECT target.id, newer.id AS before_id, newer.created_at AS before_created_at
           FROM target
           LEFT JOIN LATERAL (
             SELECT retained_shouts.id, retained_shouts.created_at
             FROM retained_shouts
             WHERE (retained_shouts.created_at, retained_shouts.id)
               > (target.created_at, target.id)
             ORDER BY retained_shouts.created_at, retained_shouts.id
             LIMIT 1
           ) newer ON true`,
          [
            viewerId,
            settings.shoutbox_visibility_mode === 'time'
              ? settings.shoutbox_visibility_hours
              : null,
            settings.shoutbox_visibility_mode === 'count'
              ? settings.shoutbox_visibility_count
              : null,
            streamKey,
            shoutId,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          return null;
        }
        return {
          before: row.before_id ? {
            createdAt: row.before_created_at.toISOString(),
            id: String(row.before_id),
          } : null,
          id: String(row.id),
          streamKey,
        };
      });
    },
    async listShoutChanges(afterCursor, limit, viewerId = null, streamKey = 'public') {
      const result = await pool.query(
        `SELECT shouts.id, shouts.account_id, shouts.body, shouts.created_at,
          shouts.updated_at, shouts.deleted_at, shouts.pinned_at, shouts.sync_cursor,
          shouts.stream_key,
          accounts.display_name, accounts.username, accounts.role, accounts.username_color,
          accounts.username_color_effect, accounts.timestamp_color, accounts.visible_to_role,
          accounts.avatar_content_type, accounts.avatar_updated_at,
          EXISTS (
            SELECT 1 FROM shout_staff_mentions
            WHERE shout_staff_mentions.shout_id = shouts.id
              AND shout_staff_mentions.active
          ) AS staff_mentioned,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'username', mentioned.username,
              'aliases', (
                SELECT COALESCE(jsonb_agg(username_history.username ORDER BY username_history.ended_at, username_history.id), '[]'::jsonb)
                FROM account_username_history username_history
                WHERE username_history.account_id = mentioned.id
              ),
              'usernameColor', mentioned.username_color,
              'usernameColorEffect', mentioned.username_color_effect
            ) ORDER BY mentioned.normalized_username)
            FROM shout_mentions
            JOIN accounts mentioned ON mentioned.id = shout_mentions.mentioned_account_id
            WHERE shout_mentions.shout_id = shouts.id
              AND mentioned.membership_status = 'active'
              AND mentioned.deleted_at IS NULL
              AND account_visible_to($3, mentioned.id)
          ), '[]'::jsonb) AS mention_accounts,
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object('count', reaction_counts.count, 'reaction', reaction_counts.reaction)
              ORDER BY reaction_counts.reaction
            )
            FROM (
              SELECT reactions.reaction, count(*)::integer AS count
              FROM shout_reactions reactions
              JOIN accounts reacting_accounts ON reacting_accounts.id = reactions.account_id
              WHERE reactions.shout_id = shouts.id
                AND account_visible_to($3, reacting_accounts.id)
              GROUP BY reactions.reaction
            ) reaction_counts
          ), '[]'::jsonb) AS reactions,
          ARRAY(
            SELECT viewer_reactions.reaction
            FROM shout_reactions viewer_reactions
            WHERE viewer_reactions.shout_id = shouts.id
              AND viewer_reactions.account_id = $3
            ORDER BY viewer_reactions.reaction
          ) AS viewer_reactions
         FROM shouts JOIN accounts ON accounts.id = shouts.account_id
         WHERE shouts.sync_cursor > $1
           AND account_visible_to($3, accounts.id)
           AND shouts.stream_key = $4
           AND shoutbox_stream_visible_to($3, $4)
           AND ($3::uuid IS NULL OR shouts.created_at >= (
             SELECT viewers.created_at FROM accounts viewers WHERE viewers.id = $3
           ))
         ORDER BY shouts.sync_cursor ASC LIMIT $2`,
        [afterCursor, limit, viewerId, streamKey],
      );
      return result.rows.map(mapShoutChange);
    },
    async manageAccount({
      action,
      actorId,
      expectedUpdatedAt,
      grants,
      reason,
      targetId,
      updatedAt,
      updates,
    }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT * FROM accounts WHERE id = $1 FOR UPDATE`,
          [targetId],
        );
        const current = currentResult.rows[0];
        if (!current || new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return { account: null };
        }

        const nextRole = updates.role ?? current.role;
        const nextMembershipStatus = updates.membershipStatus ?? current.membership_status;
        const nextDeletedAt = updates.deletedAt ?? current.deleted_at;
        if (
          ['admin', 'dev', 'owner'].includes(current.role)
          && current.membership_status === 'active'
          && !current.deleted_at
          && (!['admin', 'dev', 'owner'].includes(nextRole) || nextMembershipStatus !== 'active' || nextDeletedAt)
        ) {
          const administrators = await client.query(
            `SELECT id FROM accounts
             WHERE role IN ('admin', 'dev', 'owner')
               AND membership_status = 'active' AND deleted_at IS NULL
             FOR UPDATE`,
          );
          if (administrators.rows.length <= 1) {
            return { account: null, lastAdministrator: true };
          }
        }

        const columns = {
          deletedAt: 'deleted_at',
          forcePasswordChange: 'force_password_change',
          forumPostingMuted: 'forum_posting_muted',
          membershipStatus: 'membership_status',
          role: 'role',
          shoutboxPostingMuted: 'shoutbox_posting_muted',
          slowdownMs: 'slowdown_ms',
        };
        const parameters = [targetId];
        const assignments = Object.entries(updates).map(([key, value]) => {
          parameters.push(value);
          return `${columns[key]} = $${parameters.length}`;
        });
        parameters.push(updatedAt);
        assignments.push(`updated_at = $${parameters.length}`);
        await client.query(
          `UPDATE accounts SET ${assignments.join(', ')} WHERE id = $1`,
          parameters,
        );
        if (nextMembershipStatus !== 'active' || nextDeletedAt) {
          await client.query(
            `WITH owned_threads AS (
               SELECT threads.id, successor.account_id AS successor_account_id
               FROM direct_message_threads threads
               LEFT JOIN LATERAL (
                 SELECT members.account_id
                 FROM direct_message_members members
                 JOIN accounts ON accounts.id = members.account_id
                 WHERE members.thread_id = threads.id
                   AND members.account_id <> $1
                   AND members.left_at IS NULL
                   AND accounts.membership_status = 'active'
                   AND accounts.deleted_at IS NULL
                 ORDER BY members.joined_at, members.account_id
                 LIMIT 1
               ) successor ON true
               WHERE threads.owner_account_id = $1 AND threads.locked_at IS NULL
               FOR UPDATE OF threads
             )
             UPDATE direct_message_threads threads
             SET owner_account_id = owned_threads.successor_account_id,
               locked_at = CASE
                 WHEN owned_threads.successor_account_id IS NULL THEN $2::timestamptz
                 ELSE NULL
               END,
               updated_at = $2
             FROM owned_threads
             WHERE threads.id = owned_threads.id`,
            [targetId, updatedAt],
          );
        }
        if (nextDeletedAt) {
          await client.query(
            `UPDATE direct_message_members SET left_at = COALESCE(left_at, $2)
             WHERE account_id = $1`,
            [targetId, updatedAt],
          );
        }
        if (updates.deletedAt && !current.deleted_at) {
          const deletedIdentity = deletedAccountIdentity(targetId);
          await client.query(
            `DELETE FROM webauthn_challenges
             WHERE account_id = $1
               OR session_id IN (SELECT id FROM sessions WHERE account_id = $1)`,
            [targetId],
          );
          await client.query(
            `DELETE FROM webauthn_credentials WHERE account_id = $1`,
            [targetId],
          );
          await client.query(
            `DELETE FROM email_verification_tokens WHERE account_id = $1`,
            [targetId],
          );
          await client.query(
            `DELETE FROM password_reset_tokens WHERE account_id = $1`,
            [targetId],
          );
          await client.query(
            `DELETE FROM username_reservations
             WHERE normalized_username = $2
               OR normalized_username IN (
                 SELECT normalized_requested_username
                 FROM username_rename_requests
                 WHERE account_id = $1 AND status = 'pending'
                 UNION
                 SELECT normalized_username
                 FROM account_username_history WHERE account_id = $1
               )`,
            [targetId, current.normalized_username],
          );
          await client.query(
            `DELETE FROM account_username_history WHERE account_id = $1`,
            [targetId],
          );
          await client.query(
            `DELETE FROM username_rename_requests WHERE account_id = $1`,
            [targetId],
          );
          await client.query(
            `UPDATE accounts
             SET email = $2, normalized_email = $2, username = $3,
               display_name = $3, normalized_username = $4, email_verified_at = NULL,
               location = '', signature = '', title = ''
             WHERE id = $1`,
            [
              targetId,
              deletedIdentity.email,
              deletedIdentity.username,
              deletedIdentity.normalizedUsername,
            ],
          );
          await client.query(
            `DELETE FROM post_attachments WHERE uploader_account_id = $1`,
            [targetId],
          );
        }

        if (grants !== undefined || (updates.role && updates.role !== 'moderator')) {
          await client.query(`DELETE FROM moderator_grants WHERE account_id = $1`, [targetId]);
        }
        for (const permission of grants ?? []) {
          await client.query(
            `INSERT INTO moderator_grants (account_id, permission, granted_by)
             VALUES ($1, $2, $3)`,
            [targetId, permission, actorId],
          );
        }
        if (
          updates.deletedAt
          || updates.forcePasswordChange
          || updates.membershipStatus !== undefined
          || updates.role !== undefined
          || grants !== undefined
        ) {
          await client.query(
            `UPDATE sessions SET revoked_at = $2
             WHERE account_id = $1 AND revoked_at IS NULL`,
            [targetId, updatedAt],
          );
        }

        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [actorId, targetId, action, reason, JSON.stringify({
            after: updates,
            before: {
              forcePasswordChange: current.force_password_change,
              forumPostingMuted: current.forum_posting_muted,
              membershipStatus: current.membership_status,
              role: current.role,
              shoutboxPostingMuted: current.shoutbox_posting_muted,
              slowdownMs: current.slowdown_ms,
            },
            grants,
          })],
        );

        if (
          updates.membershipStatus !== undefined
          && nextMembershipStatus !== current.membership_status
          && nextMembershipStatus !== 'deleted'
        ) {
          await client.query(
            `INSERT INTO notifications (account_id, message, href)
             VALUES ($1, $2, '/notifications')`,
            [targetId, membershipDecisionMessages.get(nextMembershipStatus)],
          );
        }

        const updatedResult = await client.query(
          `SELECT accounts.*, COALESCE(grants.permissions, ARRAY[]::text[]) AS permissions
           FROM accounts
           LEFT JOIN LATERAL (
             SELECT array_agg(permission ORDER BY permission) AS permissions
             FROM moderator_grants WHERE account_id = accounts.id
           ) grants ON true
           WHERE accounts.id = $1`,
          [targetId],
        );
        return { account: mapManagedAccount(updatedResult.rows[0]) };
      });
    },
    async setFollowing(followerId, followedId, following) {
      return withTransaction(async (client) => {
        const result = following
          ? await client.query(
            `INSERT INTO account_follows (follower_account_id, followed_account_id)
             SELECT $1, $2 WHERE account_visible_to($1, $2)
             ON CONFLICT DO NOTHING
             RETURNING follower_account_id`,
            [followerId, followedId],
          )
          : await client.query(
            `DELETE FROM account_follows
             WHERE follower_account_id = $1 AND followed_account_id = $2
             RETURNING follower_account_id`,
            [followerId, followedId],
          );
        if (!result.rows[0]) {
          return false;
        }
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            followerId,
            followedId,
            following ? 'account.follow' : 'account.unfollow',
            following ? 'Account followed' : 'Account unfollowed',
            JSON.stringify({
              after: { following },
              before: { following: !following },
            }),
          ],
        );
        return true;
      });
    },
    async replacePasswordResetToken(accountId, tokenDigest, expiresAt) {
      await withTransaction(async (client) => {
        await client.query(`DELETE FROM password_reset_tokens WHERE account_id = $1`, [accountId]);
        await client.query(
          `INSERT INTO password_reset_tokens (token_digest, account_id, expires_at)
           VALUES ($1, $2, $3)`,
          [tokenDigest, accountId, expiresAt],
        );
      });
    },
    async replaceVerificationToken(accountId, tokenDigest, expiresAt) {
      await withTransaction(async (client) => {
        await client.query(`DELETE FROM email_verification_tokens WHERE account_id = $1`, [accountId]);
        await client.query(
          `INSERT INTO email_verification_tokens (token_digest, account_id, expires_at)
           VALUES ($1, $2, $3)`,
          [tokenDigest, accountId, expiresAt],
        );
      });
    },
    async recordAuthenticationEvent({ accountId, action, details, occurredAt }) {
      await pool.query(
        `INSERT INTO authentication_audit_events (account_id, action, details, created_at)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [accountId, action, JSON.stringify(details), occurredAt],
      );
    },
    async revokeSession(tokenDigest, revokedAt, accountId) {
      await pool.query(
        `WITH revoked AS (
           UPDATE sessions SET revoked_at = $2
           WHERE token_digest = $1 AND account_id = $3 AND revoked_at IS NULL
           RETURNING account_id, id
         )
         INSERT INTO authentication_audit_events (account_id, session_id, action)
         SELECT account_id, id, 'auth.session.logged_out' FROM revoked`,
        [tokenDigest, revokedAt, accountId],
      );
    },
    async revokeAccountSession(accountId, sessionId, revokedAt) {
      const result = await pool.query(
        `WITH revoked AS (
           UPDATE sessions SET revoked_at = $3
           WHERE account_id = $1 AND id = $2 AND revoked_at IS NULL
           RETURNING id
         ), audit_event AS (
           INSERT INTO authentication_audit_events (account_id, session_id, action)
           SELECT $1, id, 'auth.session.revoked' FROM revoked
           RETURNING id
         )
         SELECT id FROM revoked`,
        [accountId, sessionId, revokedAt],
      );
      return Boolean(result.rows[0]);
    },
    async revokeAllSessions(accountId, revokedAt) {
      return withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE sessions SET revoked_at = $2
           WHERE account_id = $1 AND revoked_at IS NULL
           RETURNING id`,
          [accountId, revokedAt],
        );
        await client.query(
          `INSERT INTO authentication_audit_events (account_id, action, details)
           VALUES ($1, 'auth.sessions.revoked_all', $2::jsonb)`,
          [accountId, JSON.stringify({ revokedCount: result.rows.length })],
        );
        return result.rows.length;
      });
    },
    async removePasskey({ accountId, credentialId, currentSessionId, removedAt }) {
      return withTransaction(async (client) => {
        await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        const credential = await client.query(
          `SELECT id, label FROM webauthn_credentials
           WHERE id = $1 AND account_id = $2
           FOR UPDATE`,
          [credentialId, accountId],
        );
        if (!credential.rows[0]) {
          return null;
        }
        const revokedSessions = await client.query(
          `UPDATE sessions SET revoked_at = $3
           WHERE account_id = $1 AND passkey_credential_id = $2 AND revoked_at IS NULL
           RETURNING id`,
          [accountId, credentialId, removedAt],
        );
        await client.query(
          `DELETE FROM webauthn_credentials
           WHERE id = $1 AND account_id = $2
           RETURNING id`,
          [credentialId, accountId],
        );
        await client.query(
          `INSERT INTO authentication_audit_events (
             account_id, action, details, created_at
           ) VALUES ($1, 'auth.passkey.removed', $2::jsonb, $3)`,
          [accountId, JSON.stringify({
            credentialIdSuffix: credentialId.slice(-8),
            label: credential.rows[0].label,
          }), removedAt],
        );
        return {
          currentSessionRevoked: revokedSessions.rows.some(({ id }) => id === currentSessionId),
        };
      });
    },
    async renamePasskey({ accountId, credentialId, label, renamedAt }) {
      return withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE webauthn_credentials
           SET label = $3
           WHERE id = $1 AND account_id = $2
           RETURNING id AS credential_id, label, transports, device_type, backed_up,
             counter, created_at AS credential_created_at, last_used_at`,
          [credentialId, accountId, label],
        );
        if (!result.rows[0]) {
          return null;
        }
        await client.query(
          `INSERT INTO authentication_audit_events (
             account_id, action, details, created_at
           ) VALUES ($1, 'auth.passkey.renamed', $2::jsonb, $3)`,
          [accountId, JSON.stringify({
            credentialIdSuffix: credentialId.slice(-8),
            label,
          }), renamedAt],
        );
        return mapPasskey(result.rows[0]);
      });
    },
    async setNotificationRead({ accountId, notificationId, read, updatedAt }) {
      const result = await pool.query(
        `UPDATE notifications SET read_at = $3
         WHERE id = $1 AND account_id = $2
           AND (
             required_permission IS NULL
             OR required_permission = 'shouts.moderate'
               AND shoutbox_stream_visible_to($2, 'staff')
           )
           AND (
             forum_topic_id IS NULL
             OR forum_topic_visible_to($2, forum_topic_id)
           )
           AND (
             shout_id IS NULL
             OR shout_visible_to($2, shout_id)
           )
         RETURNING id, message, href, read_at, created_at`,
        [notificationId, accountId, read ? updatedAt : null],
      );
      return result.rows[0] ? mapNotification(result.rows[0]) : null;
    },
    async markAllNotificationsRead({ accountId, updatedAt }) {
      const result = await pool.query(
        `UPDATE notifications SET read_at = $2
         WHERE account_id = $1 AND read_at IS NULL
           AND (
             required_permission IS NULL
             OR required_permission = 'shouts.moderate'
               AND shoutbox_stream_visible_to($1, 'staff')
           )
           AND (
             forum_topic_id IS NULL
             OR forum_topic_visible_to($1, forum_topic_id)
           )
           AND (
             shout_id IS NULL
             OR shout_visible_to($1, shout_id)
           )
         RETURNING id`,
        [accountId, updatedAt],
      );
      return result.rows.length;
    },
    async updatePreferences(accountId, preferences) {
      const result = await pool.query(
        `UPDATE accounts
         SET theme = $2, color_scheme = $3, shoutbox_enabled = $4,
           shoutbox_muted = $5, font_size = $6, font_typeface = $7,
           time_zone = $8, shoutbox_height_lines = $9, shoutbox_order = $10,
           status_and_activity_visible = $11,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          accountId,
          preferences.theme,
          preferences.colorScheme,
          preferences.shoutboxEnabled,
          preferences.shoutboxMuted,
          preferences.fontSize,
          preferences.fontTypeface,
          preferences.timeZone,
          preferences.shoutboxHeightLines,
          preferences.shoutboxOrder,
          preferences.statusAndActivityVisible,
        ],
      );
      return mapAccount(result.rows[0]);
    },
    async updateProfile(accountId, profile) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
           `SELECT description, location, profile_visitor_area_visible, signature, title, timestamp_color, username_color, username_color_effect,
             username_color_effects_unlocked_at FROM accounts
           WHERE id = $1 AND membership_status = 'active' AND deleted_at IS NULL
           FOR UPDATE`,
          [accountId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return null;
        }
        const usernameColorEffect = profile.usernameColorEffect
          ?? current.username_color_effect
          ?? 'none';
        const timestampColor = profile.timestampColor ?? current.timestamp_color ?? 'default';
        if (
          usernameColorEffect !== 'none'
          && !current.username_color_effects_unlocked_at
        ) {
          return null;
        }
        const result = await client.query(
          `UPDATE accounts
           SET description = $2, username_color = $3, username_color_effect = $4,
             timestamp_color = $5, location = $6, title = $7, signature = $8,
             profile_visitor_area_visible = $9,
             updated_at = now()
           WHERE id = $1
           RETURNING description, location, signature, title, timestamp_color, username_color,
             username_color_effect, profile_visitor_area_visible`,
          [
            accountId,
            profile.description,
            profile.usernameColor,
            usernameColorEffect,
            timestampColor,
            profile.location,
            profile.title,
            profile.signature,
            profile.profileVisitorAreaVisible,
          ],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $1, 'account.profile.update', $2, $3::jsonb)`,
          [accountId, 'Account profile updated', JSON.stringify({
            after: {
              descriptionPresent: Boolean(profile.description),
              locationPresent: Boolean(profile.location),
              profileVisitorAreaVisible: profile.profileVisitorAreaVisible,
              signaturePresent: Boolean(profile.signature),
              timestampColor,
              titlePresent: Boolean(profile.title),
              usernameColor: profile.usernameColor,
              usernameColorEffect,
            },
            before: {
              descriptionPresent: Boolean(current.description),
              locationPresent: Boolean(current.location),
              profileVisitorAreaVisible: current.profile_visitor_area_visible ?? true,
              signaturePresent: Boolean(current.signature),
              timestampColor: current.timestamp_color ?? 'default',
              titlePresent: Boolean(current.title),
              usernameColor: current.username_color,
              usernameColorEffect: current.username_color_effect,
            },
          })],
        );
        return {
          description: result.rows[0].description,
          location: result.rows[0].location,
          profileVisitorAreaVisible: result.rows[0].profile_visitor_area_visible,
          signature: result.rows[0].signature,
          timestampColor: result.rows[0].timestamp_color,
          title: result.rows[0].title,
          usernameColor: result.rows[0].username_color,
          usernameColorEffect: result.rows[0].username_color_effect,
        };
      });
    },
    async createUsernameColorUnlockCode({ actorId, createdAt, expiresAt, tokenDigest }) {
      return withTransaction(async (client) => {
        const result = await client.query(
          `INSERT INTO username_color_unlock_codes (
             token_digest, created_by_account_id, created_at, expires_at
           ) VALUES ($1, $2, $3, $4)
           RETURNING id, expires_at`,
          [tokenDigest, actorId, createdAt, expiresAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $1, 'account.username_color_unlock.issue', $2, $3::jsonb)`,
          [actorId, 'Username color unlock code issued', JSON.stringify({
            expiresAt: expiresAt.toISOString(),
            unlockCodeId: String(result.rows[0].id),
          })],
        );
        return { expiresAt: result.rows[0].expires_at, id: String(result.rows[0].id) };
      });
    },
    async redeemUsernameColorUnlockCode(accountId, tokenDigest) {
      return withTransaction(async (client) => {
        const accountResult = await client.query(
          `SELECT id FROM accounts
           WHERE id = $1 AND membership_status = 'active' AND deleted_at IS NULL
           FOR UPDATE`,
          [accountId],
        );
        if (!accountResult.rows[0]) {
          return false;
        }
        const codeResult = await client.query(
          `SELECT id FROM username_color_unlock_codes
           WHERE token_digest = $1 AND redeemed_at IS NULL AND expires_at > now()
           FOR UPDATE`,
          [tokenDigest],
        );
        const code = codeResult.rows[0];
        if (!code) {
          return false;
        }
        await client.query(
          `UPDATE username_color_unlock_codes
           SET redeemed_by_account_id = $2, redeemed_at = now()
           WHERE id = $1`,
          [code.id, accountId],
        );
        await client.query(
          `UPDATE accounts
           SET username_color_effects_unlocked_at = COALESCE(
             username_color_effects_unlocked_at, now()
           ), updated_at = now()
           WHERE id = $1`,
          [accountId],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $1, 'account.username_color_unlock.redeem', $2, $3::jsonb)`,
          [accountId, 'Username color effects unlocked', JSON.stringify({
            unlockCodeId: String(code.id),
          })],
        );
        return true;
      });
    },
    async updateAvatar({ accountId, contentType, data, updatedAt }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT avatar_updated_at FROM accounts WHERE id = $1 FOR UPDATE`,
          [accountId],
        );
        if (!currentResult.rows[0]) {
          return null;
        }
        const result = await client.query(
          `UPDATE accounts
           SET avatar_content_type = $2, avatar_data = $3, avatar_updated_at = $4,
             updated_at = $4
           WHERE id = $1 RETURNING *`,
          [accountId, contentType, data, updatedAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $1, 'account.avatar.update', $2, $3::jsonb)`,
          [accountId, 'Account avatar updated', JSON.stringify({
            after: { hasAvatar: true },
            before: { hasAvatar: Boolean(currentResult.rows[0].avatar_updated_at) },
          })],
        );
        return mapAccount(result.rows[0]);
      });
    },
  };
}
