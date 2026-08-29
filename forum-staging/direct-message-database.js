import { filterMentionAccountAliases } from './mentions.js';

function mapThread(row) {
  return {
    createdAt: row.created_at,
    id: String(row.id),
    lockedAt: row.locked_at,
    memberCount: Number(row.member_count ?? 0),
    ownerId: row.owner_account_id,
    participantUsernames: row.participant_usernames ?? [],
    title: row.title,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row) {
  const mentionAccounts = filterMentionAccountAliases(row.body, row.mention_accounts ?? [])
    .map((account) => ({
    aliases: Array.isArray(account.aliases) ? account.aliases : [],
    username: account.username,
    usernameColor: account.usernameColor ?? 'default',
    usernameColorEffect: account.usernameColorEffect ?? 'none',
    }));
  return {
    author: row.username,
    authorId: row.author_account_id,
    authorRole: row.role,
    avatarContentType: row.avatar_content_type,
    avatarUpdatedAt: row.avatar_updated_at,
    body: row.deleted_at ? null : row.body,
    createdAt: row.created_at,
    deleted: Boolean(row.deleted_at),
    id: String(row.id),
    mode: row.message_mode ?? 'post',
    mentionAccounts,
    mentionUsernames: row.mention_usernames
      ?? mentionAccounts.map((account) => account.username),
    threadId: String(row.thread_id),
    timestampColor: row.timestamp_color ?? 'default',
    updatedAt: row.updated_at ?? row.created_at,
    usernameColor: row.username_color ?? 'default',
    usernameColorEffect: row.username_color_effect ?? 'none',
  };
}

async function recordLifecycleAudit(client, {
  action,
  actorId,
  details,
  reason,
  targetId,
}) {
  await client.query(
    `INSERT INTO moderation_audit_events (
       actor_account_id, target_account_id, action, reason, details
     ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, targetId, action, reason, JSON.stringify(details)],
  );
}

async function notifyThreadMembers(
  client,
  actorId,
  threadId,
  message,
  mode = 'post',
  messageId = null,
) {
  await client.query(
    `INSERT INTO notifications (account_id, message, href)
    SELECT members.account_id, actor.username || $3,
      '/messages?thread=' || members.thread_id::text
        || CASE WHEN $4 = 'chat' THEN '&mode=chat' ELSE '' END
        || CASE WHEN $5::bigint IS NOT NULL THEN '&message=' || $5::text ELSE '' END
     FROM direct_message_members members
     JOIN accounts recipients ON recipients.id = members.account_id
     JOIN accounts actor ON actor.id = $2
     WHERE members.thread_id = $1
       AND members.account_id <> $2
       AND members.left_at IS NULL
       AND recipients.membership_status = 'active'
      AND recipients.deleted_at IS NULL
      AND account_visible_to(recipients.id, actor.id)
      AND account_visible_to(actor.id, recipients.id)`,
    [threadId, actorId, message, mode, messageId],
  );
}

export function createDirectMessageRepository(pool) {
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

  async function selectThread(queryable, threadId) {
    const result = await queryable.query(
      `SELECT threads.*,
        count(members.account_id) FILTER (WHERE members.left_at IS NULL) AS member_count
       FROM direct_message_threads threads
       LEFT JOIN direct_message_members members ON members.thread_id = threads.id
       WHERE threads.id = $1
       GROUP BY threads.id`,
      [threadId],
    );
    return result.rows[0] ? mapThread(result.rows[0]) : null;
  }

  async function selectMessage(queryable, messageId) {
    const result = await queryable.query(
      `SELECT messages.*, accounts.username, accounts.role, accounts.timestamp_color,
        accounts.username_color,
        accounts.username_color_effect, accounts.avatar_content_type,
        accounts.avatar_updated_at,
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
          FROM direct_message_mentions
          JOIN accounts mentioned
            ON mentioned.id = direct_message_mentions.mentioned_account_id
          WHERE direct_message_mentions.message_id = messages.id
            AND mentioned.membership_status = 'active'
            AND mentioned.deleted_at IS NULL
        ), '[]'::jsonb) AS mention_accounts
       FROM direct_messages messages
       JOIN accounts ON accounts.id = messages.author_account_id
       WHERE messages.id = $1`,
      [messageId],
    );
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async function selectViewerThread(queryable, accountId, threadId) {
    const result = await queryable.query(
      `SELECT threads.*, viewer_members.joined_at AS viewer_joined_at,
         viewer_members.visible_after_message_id AS viewer_visible_after_message_id
       FROM direct_message_threads threads
       JOIN direct_message_members viewer_members
         ON viewer_members.thread_id = threads.id
         AND viewer_members.account_id = $2
         AND viewer_members.left_at IS NULL
       WHERE threads.id = $1
         AND NOT EXISTS (
           SELECT 1 FROM direct_message_members peers
           WHERE peers.thread_id = threads.id
             AND peers.left_at IS NULL
             AND (
               NOT account_visible_to($2, peers.account_id)
               OR NOT account_visible_to(peers.account_id, $2)
             )
         )
       FOR SHARE OF threads, viewer_members`,
      [threadId, accountId],
    );
    return result.rows[0] ?? null;
  }

  async function selectUnreadCount(queryable, accountId) {
    const result = await queryable.query(
      `SELECT count(*)::integer AS unread_count
       FROM direct_message_members viewer_members
       JOIN direct_messages messages ON messages.thread_id = viewer_members.thread_id
       WHERE viewer_members.account_id = $1
         AND viewer_members.left_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM direct_message_members peers
           WHERE peers.thread_id = viewer_members.thread_id
             AND peers.left_at IS NULL
             AND (
               NOT account_visible_to($1, peers.account_id)
               OR NOT account_visible_to(peers.account_id, $1)
             )
         )
         AND messages.author_account_id <> $1
         AND messages.deleted_at IS NULL
         AND account_visible_to($1, messages.author_account_id)
         AND (
           (viewer_members.visible_after_message_id IS NOT NULL
             AND messages.id > viewer_members.visible_after_message_id)
           OR (viewer_members.visible_after_message_id IS NULL
             AND messages.created_at >= viewer_members.joined_at)
         )
         AND messages.id > GREATEST(
           CASE messages.message_mode
             WHEN 'chat' THEN viewer_members.last_read_chat_message_id
             ELSE GREATEST(
               viewer_members.last_read_post_message_id,
               viewer_members.last_read_message_id
             )
           END,
           0
         )`,
      [accountId],
    );
    return Number(result.rows[0]?.unread_count ?? 0);
  }

  async function selectParticipantMessageForUpdate(client, accountId, messageId, mode) {
    const result = await client.query(
      `SELECT messages.*, threads.owner_account_id, threads.locked_at,
        viewer_members.joined_at AS viewer_joined_at,
        viewer_members.visible_after_message_id AS viewer_visible_after_message_id
       FROM direct_messages messages
       JOIN direct_message_threads threads ON threads.id = messages.thread_id
       JOIN direct_message_members viewer_members
         ON viewer_members.thread_id = threads.id
         AND viewer_members.account_id = $2
         AND viewer_members.left_at IS NULL
       WHERE messages.id = $1
         AND messages.message_mode = $3
         AND (
           (viewer_members.visible_after_message_id IS NOT NULL
             AND messages.id > viewer_members.visible_after_message_id)
           OR (viewer_members.visible_after_message_id IS NULL
             AND messages.created_at >= viewer_members.joined_at)
         )
         AND NOT EXISTS (
           SELECT 1 FROM direct_message_members peers
           WHERE peers.thread_id = threads.id
             AND peers.left_at IS NULL
             AND (
               NOT account_visible_to($2, peers.account_id)
               OR NOT account_visible_to(peers.account_id, $2)
             )
         )
       FOR UPDATE OF messages, threads, viewer_members`,
      [messageId, accountId, mode],
    );
    return result.rows[0] ?? null;
  }

  async function syncMessageMentions(client, accountId, messageId, threadId, mentions) {
    await client.query(
      'DELETE FROM direct_message_mentions WHERE message_id = $1',
      [messageId],
    );
    await client.query(
      `INSERT INTO direct_message_mentions (message_id, mentioned_account_id)
       SELECT $3, accounts.id
       FROM accounts
       JOIN direct_message_members participants
         ON participants.account_id = accounts.id
         AND participants.thread_id = $4
         AND participants.left_at IS NULL
       WHERE (
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
       ON CONFLICT DO NOTHING`,
      [mentions, accountId, messageId, threadId],
    );
  }

  return {
    async deleteMessage({ actorId, deletedAt, messageId, mode = 'post', ownerEditCutoff }) {
      return withTransaction(async (client) => {
        const current = await selectParticipantMessageForUpdate(
          client,
          actorId,
          messageId,
          mode,
        );
        if (!current || current.deleted_at) {
          return { status: 'not_found' };
        }
        const author = current.author_account_id === actorId;
        const threadOwner = current.owner_account_id === actorId && !current.locked_at;
        const authorWithinWindow = author
          && !current.locked_at
          && new Date(current.created_at).getTime() >= ownerEditCutoff.getTime();
        if (!threadOwner && !authorWithinWindow) {
          return { status: 'denied' };
        }
        const auditReason = threadOwner && !author ? 'Thread owner delete' : 'Author delete';
        await client.query(
          `INSERT INTO direct_message_revisions (message_id, editor_account_id, body, reason)
           VALUES ($1, $2, $3, $4)`,
          [messageId, actorId, current.body, auditReason],
        );
        await client.query(
          `UPDATE direct_messages SET deleted_at = $2, updated_at = $2 WHERE id = $1`,
          [messageId, deletedAt],
        );
        await client.query(
          'DELETE FROM direct_message_mentions WHERE message_id = $1',
          [messageId],
        );
        await client.query(
          `UPDATE direct_message_threads SET updated_at = $2 WHERE id = $1`,
          [current.thread_id, deletedAt],
        );
        await recordLifecycleAudit(client, {
          action: 'direct_message.message_delete',
          actorId,
          details: { messageId: String(messageId), threadId: String(current.thread_id) },
          reason: auditReason,
          targetId: current.author_account_id,
        });
        return { message: await selectMessage(client, messageId), status: 'ok' };
      });
    },
    async editMessage({
      actorId,
      body,
      expectedUpdatedAt,
      mentions,
      messageId,
      mode = 'post',
      ownerEditCutoff,
      updatedAt,
    }) {
      return withTransaction(async (client) => {
        const current = await selectParticipantMessageForUpdate(
          client,
          actorId,
          messageId,
          mode,
        );
        if (!current || current.deleted_at) {
          return { status: 'not_found' };
        }
        const author = current.author_account_id === actorId;
        const threadOwner = current.owner_account_id === actorId && !current.locked_at;
        const authorWithinWindow = author
          && !current.locked_at
          && new Date(current.created_at).getTime() >= ownerEditCutoff.getTime();
        if (!threadOwner && !authorWithinWindow) {
          return { status: 'denied' };
        }
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return { status: 'conflict' };
        }
        const auditReason = threadOwner && !author ? 'Thread owner edit' : 'Author edit';
        await client.query(
          `INSERT INTO direct_message_revisions (message_id, editor_account_id, body, reason)
           VALUES ($1, $2, $3, $4)`,
          [messageId, actorId, current.body, auditReason],
        );
        await client.query(
          `UPDATE direct_messages SET body = $2, updated_at = $3 WHERE id = $1`,
          [messageId, body, updatedAt],
        );
        await syncMessageMentions(client, actorId, messageId, current.thread_id, mentions);
        await client.query(
          `UPDATE direct_message_threads SET updated_at = $2 WHERE id = $1`,
          [current.thread_id, updatedAt],
        );
        await recordLifecycleAudit(client, {
          action: 'direct_message.message_edit',
          actorId,
          details: { messageId: String(messageId), threadId: String(current.thread_id) },
          reason: auditReason,
          targetId: current.author_account_id,
        });
        return { message: await selectMessage(client, messageId), status: 'ok' };
      });
    },
    async createMessage(accountId, threadId, body, mentions = [], mode = 'post') {
      return withTransaction(async (client) => {
        const access = await client.query(
          `SELECT threads.id
           FROM direct_message_threads threads
           JOIN direct_message_members viewer_members
             ON viewer_members.thread_id = threads.id
             AND viewer_members.account_id = $2
             AND viewer_members.left_at IS NULL
           WHERE threads.id = $1 AND threads.locked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM direct_message_members peers
               WHERE peers.thread_id = threads.id
                 AND peers.left_at IS NULL
                 AND (
                   NOT account_visible_to($2, peers.account_id)
                   OR NOT account_visible_to(peers.account_id, $2)
                 )
             )
           FOR UPDATE OF threads, viewer_members`,
          [threadId, accountId],
        );
        if (!access.rows[0]) {
          return null;
        }
        const inserted = await client.query(
          `INSERT INTO direct_messages (thread_id, author_account_id, body, message_mode)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [threadId, accountId, body, mode],
        );
        await client.query(
          `INSERT INTO direct_message_mentions (message_id, mentioned_account_id)
           SELECT $3, accounts.id
           FROM accounts
           JOIN direct_message_members participants
             ON participants.account_id = accounts.id
             AND participants.thread_id = $4
             AND participants.left_at IS NULL
           WHERE (
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
           ON CONFLICT DO NOTHING`,
          [mentions, accountId, inserted.rows[0].id, threadId],
        );
        await client.query(
          `UPDATE direct_message_threads SET updated_at = now() WHERE id = $1`,
          [threadId],
        );
        await notifyThreadMembers(
          client,
          accountId,
          threadId,
          ' sent a direct message',
          mode,
          inserted.rows[0].id,
        );
        return selectMessage(client, inserted.rows[0].id);
      });
    },
    async createThread(accountId, title, usernames) {
      if (!Array.isArray(usernames) || usernames.length === 0) {
        return null;
      }
      return withTransaction(async (client) => {
        const invited = await client.query(
          `SELECT accounts.id FROM accounts
           WHERE (
               accounts.normalized_username = ANY($1::text[])
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
           ORDER BY id`,
          [usernames, accountId],
        );
        if (invited.rows.length !== usernames.length) {
          return null;
        }
        const threadResult = await client.query(
          `INSERT INTO direct_message_threads (title, owner_account_id)
           VALUES ($1, $2) RETURNING id`,
          [title, accountId],
        );
        const threadId = threadResult.rows[0].id;
        await client.query(
          `INSERT INTO direct_message_members (
             thread_id, account_id, invited_by, visible_after_message_id
           ) VALUES ($1, $2, $2, 0)`,
          [threadId, accountId],
        );
        for (const { id } of invited.rows) {
          await client.query(
            `INSERT INTO direct_message_members (
               thread_id, account_id, invited_by, visible_after_message_id
             ) VALUES ($1, $2, $3, 0)`,
            [threadId, id, accountId],
          );
        }
        await notifyThreadMembers(
          client,
          accountId,
          threadId,
          ' started a direct message with you',
        );
        await recordLifecycleAudit(client, {
          action: 'direct_message.create',
          actorId: accountId,
          details: { invitedCount: invited.rows.length, threadId: String(threadId) },
          reason: 'Private thread created',
          targetId: accountId,
        });
        return selectThread(client, threadId);
      });
    },
    async getThread(accountId, threadId, limit, offset, mode = 'post') {
      return withTransaction(async (client) => {
        const viewerThread = await selectViewerThread(client, accountId, threadId);
        if (!viewerThread) {
          return null;
        }
        const membersResult = await client.query(
          `SELECT accounts.id, accounts.username, members.joined_at
           FROM direct_message_members members
           JOIN accounts ON accounts.id = members.account_id
           WHERE members.thread_id = $1 AND members.left_at IS NULL
             AND accounts.membership_status = 'active'
             AND accounts.deleted_at IS NULL
             AND account_visible_to($2, accounts.id)
           ORDER BY members.joined_at, accounts.id`,
          [threadId, accountId],
        );
        const messagesResult = await client.query(
          `SELECT messages.*, accounts.username, accounts.role, accounts.timestamp_color,
            accounts.username_color,
            accounts.username_color_effect, accounts.avatar_content_type,
            accounts.avatar_updated_at,
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
              FROM direct_message_mentions
              JOIN accounts mentioned
                ON mentioned.id = direct_message_mentions.mentioned_account_id
              WHERE direct_message_mentions.message_id = messages.id
                AND mentioned.membership_status = 'active'
                AND mentioned.deleted_at IS NULL
                AND account_visible_to($6, mentioned.id)
            ), '[]'::jsonb) AS mention_accounts
           FROM direct_messages messages
           JOIN accounts ON accounts.id = messages.author_account_id
           WHERE messages.thread_id = $1 AND (
             ($5::bigint IS NOT NULL AND messages.id > $5)
             OR ($5::bigint IS NULL AND messages.created_at >= $4)
           )
             AND account_visible_to($6, accounts.id)
             AND messages.message_mode = $7
           ORDER BY messages.id DESC LIMIT $2 OFFSET $3`,
          [
            threadId,
            limit,
            offset,
            viewerThread.viewer_joined_at,
            viewerThread.viewer_visible_after_message_id,
            accountId,
            mode,
          ],
        );
        return {
          members: membersResult.rows.map((row) => ({
            id: row.id,
            joinedAt: row.joined_at,
            username: row.username,
          })),
          messages: messagesResult.rows.map(mapMessage),
          thread: mapThread({ ...viewerThread, member_count: membersResult.rows.length }),
        };
      });
    },
    async locateMessage(accountId, threadId, messageId, mode = 'post') {
      return withTransaction(async (client) => {
        const viewerThread = await selectViewerThread(client, accountId, threadId);
        if (!viewerThread) {
          return null;
        }
        const result = await client.query(
          `WITH visible_messages AS (
             SELECT messages.id
             FROM direct_messages messages
             JOIN accounts ON accounts.id = messages.author_account_id
             WHERE messages.thread_id = $1
               AND (
                 ($5::bigint IS NOT NULL AND messages.id > $5)
                 OR ($5::bigint IS NULL AND messages.created_at >= $4)
               )
               AND account_visible_to($2, accounts.id)
               AND messages.message_mode = $6
           )
           SELECT target.id, count(newer.id)::integer AS offset
           FROM visible_messages target
           LEFT JOIN visible_messages newer ON newer.id > target.id
           WHERE target.id = $3
           GROUP BY target.id`,
          [
            threadId,
            accountId,
            messageId,
            viewerThread.viewer_joined_at,
            viewerThread.viewer_visible_after_message_id,
            mode,
          ],
        );
        return result.rows[0] ? { offset: Number(result.rows[0].offset) } : null;
      });
    },
    async inviteMember(accountId, threadId, username) {
      return withTransaction(async (client) => {
        const access = await client.query(
          `SELECT threads.id
           FROM direct_message_threads threads
           JOIN direct_message_members owner_membership
             ON owner_membership.thread_id = threads.id
             AND owner_membership.account_id = $2
             AND owner_membership.left_at IS NULL
           WHERE threads.id = $1
             AND threads.owner_account_id = $2
             AND threads.locked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM direct_message_members peers
               WHERE peers.thread_id = threads.id
                 AND peers.left_at IS NULL
                 AND (
                   NOT account_visible_to($2, peers.account_id)
                   OR NOT account_visible_to(peers.account_id, $2)
                 )
             )
           FOR UPDATE OF threads, owner_membership`,
          [threadId, accountId],
        );
        if (!access.rows[0]) {
          return null;
        }
        const invited = await client.query(
          `SELECT accounts.id FROM accounts
           WHERE (
               accounts.normalized_username = $1
               OR EXISTS (
                 SELECT 1 FROM account_username_history username_history
                 WHERE username_history.account_id = accounts.id
                   AND username_history.normalized_username = $1
               )
             )
             AND id <> $2
             AND membership_status = 'active'
             AND deleted_at IS NULL
             AND account_visible_to($2, id)
             AND account_visible_to(id, $2)`,
          [username, accountId],
        );
        if (!invited.rows[0]) {
          return null;
        }
        const membership = await client.query(
          `INSERT INTO direct_message_members (
             thread_id, account_id, invited_by,
             visible_after_message_id, last_read_message_id,
             last_read_post_message_id, last_read_chat_message_id
           )
           SELECT $1, $2, $3,
             COALESCE(MAX(messages.id), 0), COALESCE(MAX(messages.id), 0),
             COALESCE(MAX(messages.id), 0), COALESCE(MAX(messages.id), 0)
           FROM direct_messages messages
           WHERE messages.thread_id = $1
           ON CONFLICT (thread_id, account_id) DO UPDATE
           SET invited_by = EXCLUDED.invited_by,
             joined_at = now(),
             left_at = NULL,
             visible_after_message_id = EXCLUDED.visible_after_message_id,
             last_read_message_id = EXCLUDED.last_read_message_id,
             last_read_post_message_id = EXCLUDED.last_read_post_message_id,
             last_read_chat_message_id = EXCLUDED.last_read_chat_message_id
           WHERE direct_message_members.left_at IS NOT NULL
           RETURNING account_id`,
          [threadId, invited.rows[0].id, accountId],
        );
        if (!membership.rows[0]) {
          return null;
        }
        await client.query(
          `UPDATE direct_message_threads SET updated_at = now() WHERE id = $1`,
          [threadId],
        );
        await client.query(
          `INSERT INTO notifications (account_id, message, href)
           SELECT recipients.id, actor.username || ' invited you to a direct message',
             '/messages?thread=' || $1::text
           FROM accounts recipients
           JOIN accounts actor ON actor.id = $3
           WHERE recipients.id = $2
             AND recipients.membership_status = 'active'
             AND recipients.deleted_at IS NULL
             AND account_visible_to(recipients.id, actor.id)
             AND account_visible_to(actor.id, recipients.id)`,
          [threadId, invited.rows[0].id, accountId],
        );
        await recordLifecycleAudit(client, {
          action: 'direct_message.invite',
          actorId: accountId,
          details: { threadId: String(threadId) },
          reason: 'Private thread invitation',
          targetId: invited.rows[0].id,
        });
        return selectThread(client, threadId);
      });
    },
    async leaveThread(accountId, threadId) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT threads.*
           FROM direct_message_threads threads
           JOIN direct_message_members viewer_members
             ON viewer_members.thread_id = threads.id
             AND viewer_members.account_id = $2
             AND viewer_members.left_at IS NULL
           WHERE threads.id = $1
             AND NOT EXISTS (
               SELECT 1 FROM direct_message_members peers
               WHERE peers.thread_id = threads.id
                 AND peers.left_at IS NULL
                 AND (
                   NOT account_visible_to($2, peers.account_id)
                   OR NOT account_visible_to(peers.account_id, $2)
                 )
             )
           FOR UPDATE OF threads, viewer_members`,
          [threadId, accountId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return null;
        }
        let ownerId = current.owner_account_id;
        let lockedAt = current.locked_at;
        if (ownerId === accountId && !lockedAt) {
          const successorResult = await client.query(
            `SELECT members.account_id
             FROM direct_message_members members
             JOIN accounts ON accounts.id = members.account_id
             WHERE members.thread_id = $1
               AND members.account_id <> $2
               AND members.left_at IS NULL
               AND accounts.membership_status = 'active'
               AND accounts.deleted_at IS NULL
             ORDER BY members.joined_at, members.account_id
             LIMIT 1 FOR UPDATE OF members`,
            [threadId, accountId],
          );
          ownerId = successorResult.rows[0]?.account_id ?? null;
          lockedAt = ownerId ? null : new Date();
          await client.query(
            `UPDATE direct_message_threads
             SET owner_account_id = $2, locked_at = $3, updated_at = now()
             WHERE id = $1`,
            [threadId, ownerId, lockedAt],
          );
        } else {
          await client.query(
            `UPDATE direct_message_threads SET updated_at = now() WHERE id = $1`,
            [threadId],
          );
        }
        await client.query(
          `UPDATE direct_message_members SET left_at = now()
           WHERE thread_id = $1 AND account_id = $2 AND left_at IS NULL`,
          [threadId, accountId],
        );
        await recordLifecycleAudit(client, {
          action: 'direct_message.leave',
          actorId: accountId,
          details: {
            ownershipChanged: current.owner_account_id !== ownerId,
            threadId: String(threadId),
            threadLocked: Boolean(lockedAt),
          },
          reason: 'Private thread left',
          targetId: accountId,
        });
        return { id: String(threadId), left: true, lockedAt, ownerId };
      });
    },
    async listThreads(accountId, limit, offset) {
      const result = await pool.query(
        `SELECT threads.*,
          count(members.account_id) FILTER (
            WHERE members.left_at IS NULL AND account_visible_to($1, members.account_id)
          ) AS member_count,
          ARRAY(
            SELECT accounts.username
            FROM direct_message_members participants
            JOIN accounts ON accounts.id = participants.account_id
            WHERE participants.thread_id = threads.id
              AND participants.account_id <> $1
              AND participants.left_at IS NULL
              AND accounts.membership_status = 'active'
              AND accounts.deleted_at IS NULL
              AND account_visible_to($1, accounts.id)
            ORDER BY accounts.normalized_username, accounts.id
          ) AS participant_usernames
         FROM direct_message_threads threads
         JOIN direct_message_members viewer_members
           ON viewer_members.thread_id = threads.id
           AND viewer_members.account_id = $1
           AND viewer_members.left_at IS NULL
         LEFT JOIN direct_message_members members ON members.thread_id = threads.id
         WHERE NOT EXISTS (
           SELECT 1 FROM direct_message_members peers
           WHERE peers.thread_id = threads.id
             AND peers.left_at IS NULL
             AND (
               NOT account_visible_to($1, peers.account_id)
               OR NOT account_visible_to(peers.account_id, $1)
             )
         )
         GROUP BY threads.id
         ORDER BY threads.updated_at DESC, threads.id DESC LIMIT $2 OFFSET $3`,
        [accountId, limit, offset],
      );
      return result.rows.map(mapThread);
    },
    async countUnreadMessages(accountId) {
      return selectUnreadCount(pool, accountId);
    },
    async markThreadRead(accountId, threadId, mode = 'post', throughMessageId = null) {
      return withTransaction(async (client) => {
        const cursorColumn = mode === 'chat'
          ? 'last_read_chat_message_id'
          : 'last_read_post_message_id';
        const cursorBase = mode === 'chat'
          ? `viewer_members.${cursorColumn}`
          : `GREATEST(
             viewer_members.${cursorColumn},
             viewer_members.last_read_message_id
           )`;
        const legacyCursorUpdate = mode === 'post'
          ? `,
           last_read_message_id = GREATEST(
             viewer_members.last_read_message_id,
             COALESCE((
               SELECT MAX(messages.id)
               FROM direct_messages messages
               WHERE messages.thread_id = viewer_members.thread_id
                 AND messages.message_mode = $3
                 AND ($4::bigint IS NULL OR messages.id <= $4)
             ), 0)
           )`
          : '';
        const result = await client.query(
          `UPDATE direct_message_members viewer_members
           SET ${cursorColumn} = GREATEST(
             ${cursorBase},
             COALESCE((
               SELECT MAX(messages.id)
               FROM direct_messages messages
               WHERE messages.thread_id = viewer_members.thread_id
                 AND messages.message_mode = $3
                 AND ($4::bigint IS NULL OR messages.id <= $4)
             ), 0)
           )${legacyCursorUpdate}
           WHERE viewer_members.thread_id = $1
             AND viewer_members.account_id = $2
             AND viewer_members.left_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM direct_message_members peers
               WHERE peers.thread_id = viewer_members.thread_id
                 AND peers.left_at IS NULL
                 AND (
                   NOT account_visible_to($2, peers.account_id)
                   OR NOT account_visible_to(peers.account_id, $2)
                 )
             )
             AND (
               $4::bigint IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM direct_messages target
                 JOIN accounts target_author ON target_author.id = target.author_account_id
                 WHERE target.id = $4
                   AND target.thread_id = viewer_members.thread_id
                   AND target.message_mode = $3
                   AND account_visible_to($2, target_author.id)
                   AND (
                     (viewer_members.visible_after_message_id IS NOT NULL
                       AND target.id > viewer_members.visible_after_message_id)
                     OR (viewer_members.visible_after_message_id IS NULL
                       AND target.created_at >= viewer_members.joined_at)
                   )
               )
             )
           RETURNING viewer_members.${cursorColumn}`,
          [threadId, accountId, mode, throughMessageId],
        );
        if (!result.rows[0]) {
          return null;
        }
        return { unreadCount: await selectUnreadCount(client, accountId) };
      });
    },
    async lockThread(accountId, threadId) {
      return withTransaction(async (client) => {
        const current = await client.query(
          `SELECT threads.id
           FROM direct_message_threads threads
           JOIN direct_message_members owner_membership
             ON owner_membership.thread_id = threads.id
             AND owner_membership.account_id = $2
             AND owner_membership.left_at IS NULL
           WHERE threads.id = $1
             AND threads.owner_account_id = $2
             AND threads.locked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM direct_message_members peers
               WHERE peers.thread_id = threads.id
                 AND peers.left_at IS NULL
                 AND (
                   NOT account_visible_to($2, peers.account_id)
                   OR NOT account_visible_to(peers.account_id, $2)
                 )
             )
           FOR UPDATE OF threads, owner_membership`,
          [threadId, accountId],
        );
        if (!current.rows[0]) {
          return null;
        }
        await client.query(
          `UPDATE direct_message_threads SET locked_at = now(), updated_at = now()
           WHERE id = $1`,
          [threadId],
        );
        await recordLifecycleAudit(client, {
          action: 'direct_message.lock',
          actorId: accountId,
          details: { threadId: String(threadId) },
          reason: 'Private thread locked',
          targetId: accountId,
        });
        return selectThread(client, threadId);
      });
    },
  };
}