import { filterMentionAccountAliases } from './mentions.js';

function mapTopic(row) {
  return {
    author: row.display_name,
    authorId: row.author_account_id,
    authorUsername: row.username,
    createdAt: row.created_at,
    id: String(row.id),
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    locked: row.locked,
    postCount: Number(row.post_count ?? 0),
    ...(row.subscribed === undefined ? {} : { subscribed: Boolean(row.subscribed) }),
    subforumKey: row.subforum_key ?? 'public',
    title: row.title,
    updatedAt: row.updated_at,
    usernameColor: row.username_color,
    usernameColorEffect: row.username_color_effect ?? 'none',
  };
}

function mapMentionAccounts(row) {
  return filterMentionAccountAliases(row.body, row.mention_accounts ?? []).map((account) => ({
    aliases: Array.isArray(account.aliases) ? account.aliases : [],
    username: account.username,
    usernameColor: account.usernameColor ?? 'default',
    usernameColorEffect: account.usernameColorEffect ?? 'none',
  }));
}

function mapPost(row) {
  const mentionAccounts = mapMentionAccounts(row);
  return {
    author: row.display_name,
    authorId: row.author_account_id,
    authorLocation: row.author_location ?? '',
    authorPostCount: Number(row.author_post_count ?? 0),
    authorSignature: row.author_signature ?? '',
    authorTitle: row.author_title ?? '',
    authorUsername: row.username,
    avatarContentType: row.avatar_updated_at ? row.avatar_content_type : null,
    avatarUrl: row.avatar_updated_at
      ? `/api/avatars/${row.author_account_id}?v=${new Date(row.avatar_updated_at).getTime()}`
      : null,
    ...(row.attachments === undefined ? {} : { attachments: row.attachments }),
    body: row.deleted_at ? null : row.body,
    createdAt: row.created_at,
    deleted: Boolean(row.deleted_at),
    id: String(row.id),
    mentionAccounts,
    mentionUsernames: row.mention_usernames
      ?? mentionAccounts.map((account) => account.username),
    reactions: row.reactions ?? [],
    topicSubforumKey: row.subforum_key ?? 'public',
    topicId: String(row.topic_id),
    topicTitle: row.topic_title,
    updatedAt: row.updated_at,
    viewerReaction: row.viewer_reaction ?? null,
    usernameColor: row.username_color,
    usernameColorEffect: row.username_color_effect ?? 'none',
  };
}

function mapDeletedPost(row) {
  return {
    author: row.display_name,
    authorId: row.author_account_id,
    authorUsername: row.username,
    body: row.body,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    id: String(row.id),
    topicId: String(row.topic_id),
    topicTitle: row.topic_title,
    updatedAt: row.updated_at,
  };
}

function mapPostRevision(row) {
  return {
    body: row.body,
    createdAt: row.created_at,
    id: String(row.id),
    reason: row.reason,
  };
}

function mapAttachment(row, includeData = false) {
  return {
    contentType: row.content_type,
    createdAt: row.created_at,
    ...(includeData ? { data: row.data } : {}),
    id: String(row.id),
    name: row.file_name,
    postId: String(row.post_id),
    size: Number(row.byte_size),
    url: `/api/attachments/${row.id}`,
  };
}

function mapSearchResult(row) {
  return {
    excerpt: row.excerpt,
    kind: row.kind,
    post: row.post_id ? {
      author: row.post_author,
      authorId: row.post_author_account_id,
      authorUsername: row.post_author_username,
      createdAt: row.post_created_at,
      id: String(row.post_id),
      topicId: String(row.topic_id),
      usernameColor: row.post_username_color,
      usernameColorEffect: row.post_username_color_effect ?? 'none',
    } : null,
    postOffset: Number(row.post_offset),
    topic: {
      author: row.topic_author,
      authorId: row.topic_author_account_id,
      authorUsername: row.topic_author_username,
      createdAt: row.topic_created_at,
      id: String(row.topic_id),
      locked: row.locked,
      subforumKey: row.subforum_key ?? 'public',
      title: row.title,
      updatedAt: row.topic_updated_at,
      usernameColor: row.topic_username_color,
      usernameColorEffect: row.topic_username_color_effect ?? 'none',
    },
  };
}

function postAttachmentAuthorization(post, accountId, moderator, ownerEditCutoff) {
  if (!post || post.topic_deleted_at) {
    return 'not_found';
  }
  const threadOwner = post.topic_author_account_id === accountId && !post.topic_locked;
  const ownerWithinWindow = post.author_account_id === accountId
    && !post.topic_locked
    && new Date(post.created_at).getTime() >= ownerEditCutoff.getTime();
  return moderator || threadOwner || ownerWithinWindow ? 'ok' : 'denied';
}

export function createForumRepository(pool) {
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

  async function selectPost(queryable, postId, viewerId) {
    const result = await queryable.query(
      `SELECT posts.*, topics.title AS topic_title, topics.subforum_key,
        accounts.display_name,
        accounts.username, accounts.username_color, accounts.username_color_effect,
        accounts.location AS author_location, accounts.title AS author_title,
        accounts.signature AS author_signature,
        accounts.avatar_content_type,
        accounts.avatar_updated_at,
        (
          SELECT count(*)::integer
          FROM posts author_posts
          JOIN topics author_topics ON author_topics.id = author_posts.topic_id
          WHERE author_posts.author_account_id = accounts.id
            AND author_posts.deleted_at IS NULL
            AND author_topics.deleted_at IS NULL
            AND forum_topic_visible_to($2, author_topics.id)
            AND account_visible_to($2, author_topics.author_account_id)
        ) AS author_post_count,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'contentType', post_attachments.content_type,
            'createdAt', post_attachments.created_at,
            'id', post_attachments.id::text,
            'name', post_attachments.file_name,
            'postId', post_attachments.post_id::text,
            'size', post_attachments.byte_size,
            'url', '/api/attachments/' || post_attachments.id::text
          ) ORDER BY post_attachments.id)
          FROM post_attachments WHERE post_attachments.post_id = posts.id
        ), '[]'::jsonb) AS attachments,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'count', visible_reactions.reaction_count,
            'reaction', visible_reactions.reaction
          ) ORDER BY visible_reactions.reaction)
          FROM (
            SELECT post_reactions.reaction, count(*)::integer AS reaction_count
            FROM post_reactions
            JOIN accounts reacting_accounts ON reacting_accounts.id = post_reactions.account_id
            WHERE post_reactions.post_id = posts.id
              AND reacting_accounts.membership_status = 'active'
              AND reacting_accounts.deleted_at IS NULL
              AND account_visible_to($2, reacting_accounts.id)
            GROUP BY post_reactions.reaction
          ) visible_reactions
        ), '[]'::jsonb) AS reactions,
        (
          SELECT post_reactions.reaction
          FROM post_reactions
          WHERE post_reactions.post_id = posts.id
            AND post_reactions.account_id = $2
        ) AS viewer_reaction,
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
          FROM post_mentions
          JOIN accounts mentioned ON mentioned.id = post_mentions.mentioned_account_id
          WHERE post_mentions.post_id = posts.id
            AND mentioned.membership_status = 'active'
            AND mentioned.deleted_at IS NULL
            AND account_visible_to($2, mentioned.id)
        ), '[]'::jsonb) AS mention_accounts
       FROM posts
       JOIN topics ON topics.id = posts.topic_id
       JOIN accounts ON accounts.id = posts.author_account_id
       WHERE posts.id = $1
         AND forum_topic_visible_to($2, topics.id)
         AND account_visible_to($2, posts.author_account_id)
         AND account_visible_to($2, topics.author_account_id)`,
      [postId, viewerId],
    );
    return result.rows[0] ? mapPost(result.rows[0]) : null;
  }

  async function mutatePostReaction(accountId, postId, reaction) {
    return withTransaction(async (client) => {
      const available = await client.query(
        `SELECT posts.id
         FROM posts
         JOIN topics ON topics.id = posts.topic_id
         JOIN accounts post_authors ON post_authors.id = posts.author_account_id
         JOIN accounts topic_authors ON topic_authors.id = topics.author_account_id
         WHERE posts.id = $2
           AND posts.deleted_at IS NULL
           AND topics.deleted_at IS NULL
           AND forum_topic_visible_to($1, topics.id)
           AND account_visible_to($1, post_authors.id)
           AND account_visible_to($1, topic_authors.id)
         FOR UPDATE OF posts`,
        [accountId, postId],
      );
      if (!available.rows[0]) {
        return null;
      }
      if (reaction === null) {
        await client.query(
          `DELETE FROM post_reactions
           WHERE post_id = $1 AND account_id = $2`,
          [postId, accountId],
        );
      } else {
        await client.query(
          `INSERT INTO post_reactions (post_id, account_id, reaction)
           VALUES ($1, $2, $3)
           ON CONFLICT (post_id, account_id) DO UPDATE
           SET reaction = EXCLUDED.reaction, created_at = now()`,
          [postId, accountId, reaction],
        );
      }
      return selectPost(client, postId, accountId);
    });
  }

  async function syncPostMentions(client, actorId, postId, topicId, mentions) {
    await client.query(
      `WITH target_location AS (
         SELECT ((count(page_posts.id) - 1) / 50) * 50 AS page_offset
         FROM posts target_post
         JOIN posts page_posts ON page_posts.topic_id = target_post.topic_id
           AND page_posts.deleted_at IS NULL
           AND (page_posts.created_at, page_posts.id)
             <= (target_post.created_at, target_post.id)
         WHERE target_post.id = $3 AND target_post.topic_id = $4
       ), resolved_mentions AS (
         SELECT id FROM accounts
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
           AND forum_topic_visible_to(id, $4)
       ), removed_mentions AS (
         DELETE FROM post_mentions
         WHERE post_id = $3
           AND mentioned_account_id NOT IN (SELECT id FROM resolved_mentions)
       ), inserted_mentions AS (
         INSERT INTO post_mentions (post_id, mentioned_account_id)
         SELECT $3, id FROM resolved_mentions
         ON CONFLICT DO NOTHING
         RETURNING mentioned_account_id
       )
       INSERT INTO notifications (account_id, message, href, forum_topic_id)
       SELECT inserted_mentions.mentioned_account_id,
         actor.username || ' mentioned you in a forum post',
         '/?topic=' || $4::text || '&post=' || $3::text
           || CASE WHEN target_location.page_offset > 0
             THEN '&offset=' || target_location.page_offset::text ELSE '' END,
         $4
       FROM inserted_mentions
       JOIN accounts actor ON actor.id = $2
       CROSS JOIN target_location`,
      [mentions, actorId, postId, topicId],
    );
  }

  async function notifyTopicSubscribers(client, actorId, postId, topicId) {
    await client.query(
      `WITH target_location AS (
         SELECT ((count(page_posts.id) - 1) / 50) * 50 AS page_offset
         FROM posts target_post
         JOIN posts page_posts ON page_posts.topic_id = target_post.topic_id
           AND page_posts.deleted_at IS NULL
           AND (page_posts.created_at, page_posts.id)
             <= (target_post.created_at, target_post.id)
         WHERE target_post.id = $2 AND target_post.topic_id = $3
       )
       INSERT INTO notifications (account_id, message, href, forum_topic_id)
       SELECT topic_subscriptions.account_id,
         actor.username || ' replied to ' || topics.title,
         '/?topic=' || topics.id::text || '&post=' || $2::text
           || CASE WHEN target_location.page_offset > 0
             THEN '&offset=' || target_location.page_offset::text ELSE '' END,
         topics.id
       FROM topic_subscriptions
       JOIN topics ON topics.id = topic_subscriptions.topic_id
       JOIN accounts subscribers ON subscribers.id = topic_subscriptions.account_id
       JOIN accounts actor ON actor.id = $1
      CROSS JOIN target_location
       WHERE topic_subscriptions.topic_id = $3
         AND topic_subscriptions.account_id <> $1
         AND subscribers.membership_status = 'active'
         AND subscribers.deleted_at IS NULL
         AND account_visible_to(subscribers.id, actor.id)
         AND forum_topic_visible_to(subscribers.id, topics.id)
         AND NOT EXISTS (
           SELECT 1 FROM post_mentions
           WHERE post_mentions.post_id = $2
             AND post_mentions.mentioned_account_id = topic_subscriptions.account_id
         )`,
      [actorId, postId, topicId],
    );
  }

  return {
    async authorizePostAttachment({ accountId, moderator, ownerEditCutoff, postId }) {
      const result = await pool.query(
        `SELECT posts.author_account_id, posts.created_at,
           topics.author_account_id AS topic_author_account_id,
           topics.deleted_at AS topic_deleted_at, topics.locked AS topic_locked
         FROM posts JOIN topics ON topics.id = posts.topic_id
         WHERE posts.id = $1 AND posts.deleted_at IS NULL
           AND forum_topic_visible_to($2, topics.id)
           AND account_visible_to($2, posts.author_account_id)
           AND account_visible_to($2, topics.author_account_id)`,
        [postId, accountId],
      );
      return { status: postAttachmentAuthorization(
        result.rows[0],
        accountId,
        moderator,
        ownerEditCutoff,
      ) };
    },
    async createPostAttachment({
      accountId,
      contentType,
      data,
      fileName,
      maximumCount,
      moderator,
      ownerEditCutoff,
      postId,
      quotaBytes,
    }) {
      return withTransaction(async (client) => {
        await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        const postResult = await client.query(
          `SELECT posts.author_account_id, posts.created_at,
             topics.author_account_id AS topic_author_account_id,
             topics.deleted_at AS topic_deleted_at, topics.locked AS topic_locked
           FROM posts JOIN topics ON topics.id = posts.topic_id
           WHERE posts.id = $1 AND posts.deleted_at IS NULL
             AND forum_topic_visible_to($2, topics.id)
             AND account_visible_to($2, posts.author_account_id)
             AND account_visible_to($2, topics.author_account_id)
           FOR UPDATE OF topics, posts`,
           [postId, accountId],
        );
        const post = postResult.rows[0];
        const authorization = postAttachmentAuthorization(
          post,
          accountId,
          moderator,
          ownerEditCutoff,
        );
        if (authorization !== 'ok') {
          return { status: authorization };
        }
        const usageResult = await client.query(
          `SELECT
             (SELECT count(*) FROM post_attachments WHERE post_id = $1) AS post_count,
             (SELECT COALESCE(sum(byte_size), 0) FROM post_attachments
              WHERE uploader_account_id = $2) AS account_bytes`,
          [postId, accountId],
        );
        if (Number(usageResult.rows[0].post_count) >= maximumCount) {
          return { status: 'limit' };
        }
        if (Number(usageResult.rows[0].account_bytes) + data.length > quotaBytes) {
          return { status: 'quota' };
        }
        const inserted = await client.query(
          `INSERT INTO post_attachments (
             post_id, uploader_account_id, file_name, content_type, byte_size, data
           ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [postId, accountId, fileName, contentType, data.length, data],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'post.attachment.create', 'Post attachment added',
             jsonb_build_object(
               'attachmentId', $3::text, 'postId', $4::text,
               'contentType', $5::text, 'byteSize', $6::integer
             ))`,
          [
            accountId,
            post.author_account_id,
            inserted.rows[0].id,
            postId,
            contentType,
            data.length,
          ],
        );
        return { attachment: mapAttachment(inserted.rows[0]), status: 'ok' };
      });
    },
    async deletePostAttachment({
      accountId,
      attachmentId,
      moderator,
      ownerEditCutoff,
      reason,
    }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT post_attachments.*, posts.author_account_id,
             posts.created_at AS post_created_at,
             topics.author_account_id AS topic_author_account_id,
             topics.deleted_at AS topic_deleted_at, topics.locked AS topic_locked
           FROM post_attachments
           JOIN posts ON posts.id = post_attachments.post_id
           JOIN topics ON topics.id = posts.topic_id
           WHERE post_attachments.id = $1 AND posts.deleted_at IS NULL
             AND forum_topic_visible_to($2, topics.id)
             AND account_visible_to($2, posts.author_account_id)
             AND account_visible_to($2, topics.author_account_id)
           FOR UPDATE OF post_attachments, posts, topics`,
           [attachmentId, accountId],
        );
        const current = currentResult.rows[0];
        if (!current || current.topic_deleted_at) {
          return { status: 'not_found' };
        }
        const threadOwner = current.topic_author_account_id === accountId && !current.topic_locked;
        const ownerWithinWindow = current.author_account_id === accountId
          && !current.topic_locked
          && new Date(current.post_created_at).getTime() >= ownerEditCutoff.getTime();
        if (!moderator && !threadOwner && !ownerWithinWindow) {
          return { status: 'denied' };
        }
        const auditReason = moderator
          ? reason
          : threadOwner && current.author_account_id !== accountId
            ? 'Thread owner attachment removal'
            : 'Author attachment removal';
        await client.query('DELETE FROM post_attachments WHERE id = $1', [attachmentId]);
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'post.attachment.delete', $3, jsonb_build_object(
             'attachmentId', $4::text, 'postId', $5::text,
             'contentType', $6::text, 'byteSize', $7::integer
           ))`,
          [
            accountId,
            current.author_account_id,
            auditReason,
            attachmentId,
            current.post_id,
            current.content_type,
            current.byte_size,
          ],
        );
        return { attachment: mapAttachment(current), status: 'ok' };
      });
    },
    async getPostAttachment(viewerId, attachmentId) {
      const result = await pool.query(
        `SELECT post_attachments.* FROM post_attachments
         JOIN posts ON posts.id = post_attachments.post_id
         JOIN topics ON topics.id = posts.topic_id
         WHERE post_attachments.id = $2
           AND posts.deleted_at IS NULL AND topics.deleted_at IS NULL
           AND forum_topic_visible_to($1, topics.id)
           AND account_visible_to($1, posts.author_account_id)
           AND account_visible_to($1, topics.author_account_id)`,
        [viewerId, attachmentId],
      );
      return result.rows[0] ? mapAttachment(result.rows[0], true) : null;
    },
    async createTopic(accountId, subforumKey, title, body, mentions) {
      return withTransaction(async (client) => {
        const topicResult = await client.query(
          `INSERT INTO topics (author_account_id, subforum_key, title)
           SELECT $1, $2, $3 WHERE forum_subforum_visible_to($1, $2)
           RETURNING *`,
          [accountId, subforumKey, title],
        );
        if (!topicResult.rows[0]) {
          return null;
        }
        const postResult = await client.query(
          `INSERT INTO posts (topic_id, author_account_id, body)
           VALUES ($1, $2, $3) RETURNING id`,
          [topicResult.rows[0].id, accountId, body],
        );
        await client.query(
          `INSERT INTO topic_subscriptions (account_id, topic_id) VALUES ($1, $2)`,
          [accountId, topicResult.rows[0].id],
        );
        await syncPostMentions(
          client,
          accountId,
          postResult.rows[0].id,
          topicResult.rows[0].id,
          mentions,
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES
             ($1, $1, 'topic.create', 'Topic created',
               jsonb_build_object('topicId', $2::text, 'subforumKey', $4::text)),
             ($1, $1, 'post.create', 'Post created',
               jsonb_build_object('postId', $3::text, 'topicId', $2::text))`,
          [accountId, topicResult.rows[0].id, postResult.rows[0].id, subforumKey],
        );
        const post = await selectPost(client, postResult.rows[0].id, accountId);
        return { post, topic: { ...mapTopic(topicResult.rows[0]), subscribed: true } };
      });
    },
    async createPost(accountId, topicId, body, mentions) {
      return withTransaction(async (client) => {
        const result = await client.query(
          `WITH inserted AS (
             INSERT INTO posts (topic_id, author_account_id, body)
             SELECT id, $1, $3 FROM topics
             WHERE id = $2 AND locked = false AND deleted_at IS NULL
               AND forum_topic_visible_to($1, id)
               AND account_visible_to($1, author_account_id)
             RETURNING id, topic_id
           )
           UPDATE topics SET updated_at = now()
           FROM inserted WHERE topics.id = inserted.topic_id
           RETURNING inserted.id`,
          [accountId, topicId, body],
        );
        if (!result.rows[0]) {
          return null;
        }
        await syncPostMentions(client, accountId, result.rows[0].id, topicId, mentions);
        await notifyTopicSubscribers(client, accountId, result.rows[0].id, topicId);
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $1, 'post.create', 'Post created', jsonb_build_object(
             'postId', $2::text, 'topicId', $3::text
           ))`,
          [accountId, result.rows[0].id, topicId],
        );
        return selectPost(client, result.rows[0].id, accountId);
      });
    },
    async deletePost({ actorId, deletedAt, moderator, ownerEditCutoff, postId, reason }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT posts.*, topics.author_account_id AS topic_author_account_id,
             topics.deleted_at AS topic_deleted_at, topics.locked AS topic_locked
           FROM posts JOIN topics ON topics.id = posts.topic_id
           WHERE posts.id = $1 AND posts.deleted_at IS NULL
             AND forum_topic_visible_to($2, topics.id)
             AND account_visible_to($2, posts.author_account_id)
             AND account_visible_to($2, topics.author_account_id)
           FOR UPDATE OF topics, posts`,
           [postId, actorId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return { status: 'not_found' };
        }
        const threadOwner = current.topic_author_account_id === actorId && !current.topic_locked;
        const ownerWithinWindow = current.author_account_id === actorId
          && !current.topic_locked
          && !current.topic_deleted_at
          && new Date(current.created_at).getTime() >= ownerEditCutoff.getTime();
        if (!moderator && !threadOwner && !ownerWithinWindow) {
          return { status: 'denied' };
        }
        const auditReason = moderator
          ? reason
          : threadOwner && current.author_account_id !== actorId
            ? 'Thread owner deletion'
            : 'Author deletion';
        await client.query(
          `INSERT INTO post_revisions (post_id, editor_account_id, body, reason)
           VALUES ($1, $2, $3, $4)`,
          [postId, actorId, current.body, auditReason],
        );
        await client.query(
          `UPDATE posts SET deleted_at = $2, updated_at = $2 WHERE id = $1`,
          [postId, deletedAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'post.delete', $3, jsonb_build_object(
             'postId', $4::text, 'topicId', $5::text
           ))`,
          [actorId, current.author_account_id, auditReason, postId, current.topic_id],
        );
        return { post: await selectPost(client, postId, actorId), status: 'ok' };
      });
    },
    async inspectDeletedPost(viewerId, postId, limit, offset) {
      const postResult = await pool.query(
        `SELECT posts.*, topics.title AS topic_title, accounts.display_name, accounts.username
         FROM posts
         JOIN topics ON topics.id = posts.topic_id
         JOIN accounts ON accounts.id = posts.author_account_id
         WHERE posts.id = $2
           AND posts.deleted_at IS NOT NULL
           AND topics.deleted_at IS NULL
           AND forum_topic_visible_to($1, topics.id)
           AND account_visible_to($1, posts.author_account_id)
           AND account_visible_to($1, topics.author_account_id)`,
        [viewerId, postId],
      );
      if (!postResult.rows[0]) {
        return null;
      }
      const revisionsResult = await pool.query(
        `SELECT id, body, reason, created_at
         FROM post_revisions
         WHERE post_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [postId, limit, offset],
      );
      return {
        post: mapDeletedPost(postResult.rows[0]),
        revisions: revisionsResult.rows.map(mapPostRevision),
      };
    },
    async editPost({
      actorId,
      body,
      expectedUpdatedAt,
      mentions,
      moderator,
      ownerEditCutoff,
      postId,
      reason,
      updatedAt,
    }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT posts.*, topics.author_account_id AS topic_author_account_id,
             topics.deleted_at AS topic_deleted_at, topics.locked AS topic_locked
           FROM posts JOIN topics ON topics.id = posts.topic_id
           WHERE posts.id = $1 AND posts.deleted_at IS NULL
             AND forum_topic_visible_to($2, topics.id)
             AND account_visible_to($2, posts.author_account_id)
             AND account_visible_to($2, topics.author_account_id)
           FOR UPDATE OF topics, posts`,
           [postId, actorId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return { status: 'not_found' };
        }
        const author = current.author_account_id === actorId;
        const threadOwner = current.topic_author_account_id === actorId && !current.topic_locked;
        const ownerWithinWindow = current.author_account_id === actorId
          && !current.topic_locked
          && !current.topic_deleted_at
          && new Date(current.created_at).getTime() >= ownerEditCutoff.getTime();
        if (!moderator && !threadOwner && !ownerWithinWindow) {
          return { status: 'denied' };
        }
        const moderating = moderator && !author && !threadOwner;
        if (moderating && !reason) {
          return { status: 'reason_required' };
        }
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return { status: 'conflict' };
        }
        const auditReason = moderating
          ? reason
          : threadOwner && !author
            ? 'Thread owner edit'
            : 'Author edit';
        await client.query(
          `INSERT INTO post_revisions (post_id, editor_account_id, body, reason)
           VALUES ($1, $2, $3, $4)`,
          [postId, actorId, current.body, auditReason],
        );
        await client.query(
          `UPDATE posts SET body = $2, updated_at = $3 WHERE id = $1`,
          [postId, body, updatedAt],
        );
        await syncPostMentions(client, actorId, postId, current.topic_id, mentions);
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'post.edit', $3, jsonb_build_object(
             'postId', $4::text, 'topicId', $5::text
           ))`,
          [actorId, current.author_account_id, auditReason, postId, current.topic_id],
        );
        return { post: await selectPost(client, postId, actorId), status: 'ok' };
      });
    },
    async editTopic({ actorId, expectedUpdatedAt, moderator, reason, title, topicId, updatedAt }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT * FROM topics
           WHERE id = $1 AND deleted_at IS NULL
             AND forum_topic_visible_to($2, id)
             AND account_visible_to($2, author_account_id)
           FOR UPDATE`,
          [topicId, actorId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return { status: 'not_found' };
        }
        const owner = current.author_account_id === actorId;
        if (!moderator && (!owner || current.locked)) {
          return { status: 'denied' };
        }
        const moderating = moderator && !owner;
        if (moderating && !reason) {
          return { status: 'reason_required' };
        }
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return { status: 'conflict' };
        }
        const auditReason = moderating ? reason : 'Thread owner edit';
        const result = await client.query(
          `UPDATE topics SET title = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
          [topicId, title, updatedAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'topic.edit', $3, jsonb_build_object(
             'topicId', $4::text, 'previousTitle', $5::text, 'title', $6::text
           ))`,
          [actorId, current.author_account_id, auditReason, topicId, current.title, title],
        );
        return { status: 'ok', topic: mapTopic(result.rows[0]) };
      });
    },
    async getTopic(topicId, accountId, limit, offset) {
      const topicResult = await pool.query(
        `SELECT topics.*, accounts.display_name, accounts.username, accounts.username_color,
          accounts.username_color_effect,
          EXISTS (
            SELECT 1 FROM topic_subscriptions
            WHERE topic_subscriptions.topic_id = topics.id
              AND topic_subscriptions.account_id = $2
          ) AS subscribed
         FROM topics JOIN accounts ON accounts.id = topics.author_account_id
         WHERE topics.id = $1 AND topics.deleted_at IS NULL
           AND forum_topic_visible_to($2, topics.id)
           AND account_visible_to($2, accounts.id)`,
        [topicId, accountId],
      );
      if (!topicResult.rows[0]) {
        return null;
      }
      const postsResult = await pool.query(
        `SELECT posts.*, topics.subforum_key, accounts.display_name, accounts.username,
          accounts.username_color,
          accounts.username_color_effect,
          accounts.location AS author_location, accounts.title AS author_title,
          accounts.signature AS author_signature,
          accounts.avatar_content_type, accounts.avatar_updated_at,
          (
            SELECT count(*)::integer
            FROM posts author_posts
            JOIN topics author_topics ON author_topics.id = author_posts.topic_id
            WHERE author_posts.author_account_id = accounts.id
              AND author_posts.deleted_at IS NULL
              AND author_topics.deleted_at IS NULL
              AND forum_topic_visible_to($4, author_topics.id)
              AND account_visible_to($4, author_topics.author_account_id)
          ) AS author_post_count,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'contentType', post_attachments.content_type,
              'createdAt', post_attachments.created_at,
              'id', post_attachments.id::text,
              'name', post_attachments.file_name,
              'postId', post_attachments.post_id::text,
              'size', post_attachments.byte_size,
              'url', '/api/attachments/' || post_attachments.id::text
            ) ORDER BY post_attachments.id)
            FROM post_attachments WHERE post_attachments.post_id = posts.id
          ), '[]'::jsonb) AS attachments,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'count', visible_reactions.reaction_count,
              'reaction', visible_reactions.reaction
            ) ORDER BY visible_reactions.reaction)
            FROM (
              SELECT post_reactions.reaction, count(*)::integer AS reaction_count
              FROM post_reactions
              JOIN accounts reacting_accounts ON reacting_accounts.id = post_reactions.account_id
              WHERE post_reactions.post_id = posts.id
                AND reacting_accounts.membership_status = 'active'
                AND reacting_accounts.deleted_at IS NULL
                AND account_visible_to($4, reacting_accounts.id)
              GROUP BY post_reactions.reaction
            ) visible_reactions
          ), '[]'::jsonb) AS reactions,
          (
            SELECT post_reactions.reaction
            FROM post_reactions
            WHERE post_reactions.post_id = posts.id
              AND post_reactions.account_id = $4
          ) AS viewer_reaction,
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
            FROM post_mentions
            JOIN accounts mentioned ON mentioned.id = post_mentions.mentioned_account_id
            WHERE post_mentions.post_id = posts.id
              AND mentioned.membership_status = 'active'
              AND mentioned.deleted_at IS NULL
              AND account_visible_to($4, mentioned.id)
          ), '[]'::jsonb) AS mention_accounts
         FROM posts
         JOIN topics ON topics.id = posts.topic_id
         JOIN accounts ON accounts.id = posts.author_account_id
         WHERE posts.topic_id = $1
           AND forum_topic_visible_to($4, posts.topic_id)
           AND account_visible_to($4, accounts.id)
         ORDER BY posts.created_at, posts.id LIMIT $2 OFFSET $3`,
        [topicId, limit, offset, accountId],
      );
      return { posts: postsResult.rows.map(mapPost), topic: mapTopic(topicResult.rows[0]) };
    },
    async clearPostReaction(accountId, postId) {
      return mutatePostReaction(accountId, postId, null);
    },
    async setPostReaction(accountId, postId, reaction) {
      return mutatePostReaction(accountId, postId, reaction);
    },
    async listPostReactions(viewerId, postId, reaction, limit, offset) {
      const available = await pool.query(
        `SELECT 1
         FROM posts
         JOIN topics ON topics.id = posts.topic_id
         JOIN accounts post_authors ON post_authors.id = posts.author_account_id
         JOIN accounts topic_authors ON topic_authors.id = topics.author_account_id
         WHERE posts.id = $1
           AND posts.deleted_at IS NULL
           AND topics.deleted_at IS NULL
           AND forum_topic_visible_to($2, topics.id)
           AND account_visible_to($2, post_authors.id)
           AND account_visible_to($2, topic_authors.id)`,
        [postId, viewerId],
      );
      if (!available.rows[0]) {
        return null;
      }
      const result = await pool.query(
        `SELECT post_reactions.reaction, accounts.display_name, accounts.username,
          accounts.username_color, accounts.username_color_effect
         FROM post_reactions
         JOIN accounts ON accounts.id = post_reactions.account_id
         WHERE post_reactions.post_id = $1
           AND ($2::text IS NULL OR post_reactions.reaction = $2)
           AND accounts.membership_status = 'active'
           AND accounts.deleted_at IS NULL
           AND account_visible_to($5, accounts.id)
         ORDER BY post_reactions.reaction, accounts.normalized_username, accounts.id
         LIMIT $3 OFFSET $4`,
        [postId, reaction, limit, offset, viewerId],
      );
      return result.rows.map((row) => ({
        displayName: row.display_name,
        reaction: row.reaction,
        username: row.username,
        usernameColor: row.username_color,
        usernameColorEffect: row.username_color_effect ?? 'none',
      }));
    },
    async setTopicSubscription(accountId, topicId, subscribed) {
      const action = subscribed ? 'topic.subscribe' : 'topic.unsubscribe';
      const reason = subscribed ? 'Topic subscribed' : 'Topic unsubscribed';
      const statement = subscribed
        ? `WITH available_topic AS (
             SELECT id FROM topics WHERE id = $2 AND deleted_at IS NULL
               AND forum_topic_visible_to($1, id)
               AND account_visible_to($1, author_account_id)
           ), changed AS (
             INSERT INTO topic_subscriptions (account_id, topic_id)
             SELECT $1, id FROM available_topic
             ON CONFLICT DO NOTHING
             RETURNING topic_id
           ), audit_event AS (
             INSERT INTO moderation_audit_events (
               actor_account_id, target_account_id, action, reason, details
             )
             SELECT $1, $1, $3, $4, jsonb_build_object(
               'topicId', $2::text,
               'after', jsonb_build_object('subscribed', $5::boolean),
               'before', jsonb_build_object('subscribed', NOT $5::boolean)
             ) FROM changed
             RETURNING id
           )
           SELECT EXISTS (SELECT 1 FROM available_topic) AS available,
             EXISTS (SELECT 1 FROM audit_event) AS audited`
        : `WITH available_topic AS (
             SELECT id FROM topics WHERE id = $2 AND deleted_at IS NULL
               AND forum_topic_visible_to($1, id)
               AND account_visible_to($1, author_account_id)
           ), changed AS (
             DELETE FROM topic_subscriptions
             USING available_topic
             WHERE topic_subscriptions.account_id = $1
               AND topic_subscriptions.topic_id = available_topic.id
             RETURNING topic_subscriptions.topic_id
           ), audit_event AS (
             INSERT INTO moderation_audit_events (
               actor_account_id, target_account_id, action, reason, details
             )
             SELECT $1, $1, $3, $4, jsonb_build_object(
               'topicId', $2::text,
               'after', jsonb_build_object('subscribed', $5::boolean),
               'before', jsonb_build_object('subscribed', NOT $5::boolean)
             ) FROM changed
             RETURNING id
           )
           SELECT EXISTS (SELECT 1 FROM available_topic) AS available,
             EXISTS (SELECT 1 FROM audit_event) AS audited`;
      const result = await pool.query(statement, [accountId, topicId, action, reason, subscribed]);
      return result.rows[0]?.available ? { subscribed } : null;
    },
    async listPostsByAccount(viewerId, accountId, limit, offset) {
      const result = await pool.query(
        `SELECT posts.*, topics.title AS topic_title, topics.subforum_key,
          accounts.display_name,
          accounts.username, accounts.username_color, accounts.username_color_effect,
          accounts.avatar_content_type,
          accounts.avatar_updated_at,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'contentType', post_attachments.content_type,
              'createdAt', post_attachments.created_at,
              'id', post_attachments.id::text,
              'name', post_attachments.file_name,
              'postId', post_attachments.post_id::text,
              'size', post_attachments.byte_size,
              'url', '/api/attachments/' || post_attachments.id::text
            ) ORDER BY post_attachments.id)
            FROM post_attachments WHERE post_attachments.post_id = posts.id
          ), '[]'::jsonb) AS attachments,
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
            FROM post_mentions
            JOIN accounts mentioned ON mentioned.id = post_mentions.mentioned_account_id
            WHERE post_mentions.post_id = posts.id
              AND mentioned.membership_status = 'active'
              AND mentioned.deleted_at IS NULL
              AND account_visible_to($1, mentioned.id)
          ), '[]'::jsonb) AS mention_accounts
         FROM posts
         JOIN topics ON topics.id = posts.topic_id
         JOIN accounts ON accounts.id = posts.author_account_id
         WHERE posts.author_account_id = $2
           AND posts.deleted_at IS NULL
           AND topics.deleted_at IS NULL
           AND forum_topic_visible_to($1, topics.id)
           AND account_visible_to($1, accounts.id)
           AND account_visible_to($1, topics.author_account_id)
         ORDER BY posts.created_at DESC, posts.id DESC LIMIT $3 OFFSET $4`,
        [viewerId, accountId, limit, offset],
      );
      return result.rows.map(mapPost);
    },
    async listTopicsByAccount(viewerId, accountId, limit) {
      const result = await pool.query(
        `SELECT topics.*, accounts.display_name, accounts.username, accounts.username_color,
          accounts.username_color_effect,
          count(posts.id) FILTER (WHERE posts.deleted_at IS NULL) AS post_count,
          COALESCE(max(posts.updated_at) FILTER (WHERE posts.deleted_at IS NULL), topics.updated_at)
            AS last_activity_at
         FROM topics
         JOIN accounts ON accounts.id = topics.author_account_id
         LEFT JOIN posts ON posts.topic_id = topics.id
         WHERE topics.author_account_id = $2 AND topics.deleted_at IS NULL
           AND forum_topic_visible_to($1, topics.id)
           AND account_visible_to($1, accounts.id)
         GROUP BY topics.id, accounts.display_name, accounts.username,
           accounts.username_color, accounts.username_color_effect
         ORDER BY topics.created_at DESC, topics.id DESC LIMIT $3`,
        [viewerId, accountId, limit],
      );
      return result.rows.map(mapTopic);
    },
    async listTopics(viewerId, subforumKey, limit, offset) {
      const result = await pool.query(
        `SELECT topics.*, accounts.display_name, accounts.username, accounts.username_color,
          accounts.username_color_effect,
          count(posts.id) FILTER (WHERE posts.deleted_at IS NULL) AS post_count,
          COALESCE(max(posts.updated_at) FILTER (WHERE posts.deleted_at IS NULL), topics.updated_at)
            AS last_activity_at
         FROM topics
         JOIN accounts ON accounts.id = topics.author_account_id
         LEFT JOIN posts ON posts.topic_id = topics.id
           AND account_visible_to($1, posts.author_account_id)
         WHERE topics.deleted_at IS NULL
           AND topics.subforum_key = $2
           AND forum_subforum_visible_to($1, $2)
           AND account_visible_to($1, accounts.id)
         GROUP BY topics.id, accounts.display_name, accounts.username,
           accounts.username_color, accounts.username_color_effect
         ORDER BY last_activity_at DESC, topics.id DESC LIMIT $3 OFFSET $4`,
        [viewerId, subforumKey, limit, offset],
      );
      return result.rows.map(mapTopic);
    },
    async searchContent(viewerId, query, limit, offset) {
      const result = await pool.query(
        `WITH search_query AS (
           SELECT plainto_tsquery('simple', $2) AS value
         ), matches AS (
           SELECT 'topic'::text AS kind, topics.id AS topic_id, NULL::bigint AS post_id,
             topics.title, topics.author_account_id AS topic_author_account_id,
             topic_authors.display_name AS topic_author,
             topic_authors.username AS topic_author_username,
             topic_authors.username_color AS topic_username_color,
             topic_authors.username_color_effect AS topic_username_color_effect,
             topics.created_at AS topic_created_at, topics.updated_at AS topic_updated_at,
             topics.locked, topics.subforum_key, left(topics.title, 240) AS excerpt,
             NULL::uuid AS post_author_account_id, NULL::text AS post_author,
             NULL::text AS post_author_username, NULL::text AS post_username_color,
             NULL::text AS post_username_color_effect,
             NULL::timestamptz AS post_created_at, 0::bigint AS post_offset,
             ts_rank(to_tsvector('simple', topics.title), search_query.value) AS rank,
             topics.updated_at AS matched_at
           FROM topics
           JOIN accounts topic_authors ON topic_authors.id = topics.author_account_id
           CROSS JOIN search_query
           WHERE topics.deleted_at IS NULL
             AND forum_topic_visible_to($1, topics.id)
             AND account_visible_to($1, topic_authors.id)
             AND to_tsvector('simple', topics.title) @@ search_query.value
           UNION ALL
           SELECT 'post'::text AS kind, topics.id AS topic_id, posts.id AS post_id,
             topics.title, topics.author_account_id AS topic_author_account_id,
             topic_authors.display_name AS topic_author,
             topic_authors.username AS topic_author_username,
             topic_authors.username_color AS topic_username_color,
             topic_authors.username_color_effect AS topic_username_color_effect,
             topics.created_at AS topic_created_at, topics.updated_at AS topic_updated_at,
             topics.locked, topics.subforum_key, left(posts.body, 240) AS excerpt,
             posts.author_account_id AS post_author_account_id,
             post_authors.display_name AS post_author,
             post_authors.username AS post_author_username,
             post_authors.username_color AS post_username_color,
             post_authors.username_color_effect AS post_username_color_effect,
             posts.created_at AS post_created_at,
             (SELECT count(*) FROM posts earlier_posts
              WHERE earlier_posts.topic_id = posts.topic_id
                AND forum_topic_visible_to($1, earlier_posts.topic_id)
                AND account_visible_to($1, earlier_posts.author_account_id)
                AND (earlier_posts.created_at, earlier_posts.id)
                  < (posts.created_at, posts.id)) AS post_offset,
             ts_rank(to_tsvector('simple', posts.body), search_query.value) AS rank,
             posts.updated_at AS matched_at
           FROM posts
           JOIN topics ON topics.id = posts.topic_id
           JOIN accounts topic_authors ON topic_authors.id = topics.author_account_id
           JOIN accounts post_authors ON post_authors.id = posts.author_account_id
           CROSS JOIN search_query
           WHERE posts.deleted_at IS NULL
             AND topics.deleted_at IS NULL
             AND forum_topic_visible_to($1, topics.id)
             AND account_visible_to($1, topic_authors.id)
             AND account_visible_to($1, post_authors.id)
             AND to_tsvector('simple', posts.body) @@ search_query.value
         )
         SELECT * FROM matches
         ORDER BY rank DESC, matched_at DESC, topic_id DESC, post_id DESC NULLS LAST
         LIMIT $3 OFFSET $4`,
        [viewerId, query, limit, offset],
      );
      return result.rows.map(mapSearchResult);
    },
    async restorePost({ actorId, expectedUpdatedAt, postId, reason, restoredAt }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT posts.*
           FROM posts
           JOIN topics ON topics.id = posts.topic_id
           WHERE posts.id = $1
             AND posts.deleted_at IS NOT NULL
             AND topics.deleted_at IS NULL
             AND forum_topic_visible_to($2, topics.id)
             AND account_visible_to($2, posts.author_account_id)
             AND account_visible_to($2, topics.author_account_id)
           FOR UPDATE OF topics, posts`,
          [postId, actorId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return { status: 'not_found' };
        }
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return { status: 'conflict' };
        }
        await client.query(
          `UPDATE posts SET deleted_at = NULL, updated_at = $2 WHERE id = $1`,
          [postId, restoredAt],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'post.restore', $3, jsonb_build_object(
             'postId', $4::text, 'topicId', $5::text
           ))`,
          [actorId, current.author_account_id, reason, postId, current.topic_id],
        );
        return { post: await selectPost(client, postId, actorId), status: 'ok' };
      });
    },
    async deleteTopic({ actorId, deletedAt, moderator, reason, topicId }) {
      return withTransaction(async (client) => {
        const currentResult = await client.query(
          `SELECT * FROM topics
           WHERE id = $1 AND deleted_at IS NULL
             AND forum_topic_visible_to($2, id)
             AND account_visible_to($2, author_account_id)
           FOR UPDATE`,
          [topicId, actorId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          return { status: 'not_found' };
        }
        if (!moderator && (current.author_account_id !== actorId || current.locked)) {
          return { status: 'denied' };
        }
        const auditReason = moderator ? reason : 'Thread owner deletion';
        const result = await client.query(
          `UPDATE topics SET deleted_at = $2, updated_at = $2 WHERE id = $1 RETURNING *`,
          [topicId, deletedAt],
        );
        await client.query(
          `DELETE FROM post_attachments USING posts
           WHERE post_attachments.post_id = posts.id AND posts.topic_id = $1`,
          [topicId],
        );
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, 'topic.delete', $3, jsonb_build_object(
             'topicId', $4::text, 'title', $5::text
           ))`,
          [actorId, current.author_account_id, auditReason, topicId, current.title],
        );
        return { status: 'ok', topic: mapTopic(result.rows[0]) };
      });
    },
    async setTopicLocked(topicId, locked, actorId, updatedAt) {
      return withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE topics SET locked = $2, updated_at = $3
           WHERE id = $1 AND deleted_at IS NULL
             AND forum_topic_visible_to($4, id)
             AND account_visible_to($4, author_account_id)
           RETURNING *`,
          [topicId, locked, updatedAt, actorId],
        );
        if (!result.rows[0]) {
          return null;
        }
        await client.query(
          `INSERT INTO moderation_audit_events (
             actor_account_id, target_account_id, action, reason, details
           ) VALUES ($1, $2, $3, $4, jsonb_build_object('topicId', $5::text))`,
          [
            actorId,
            result.rows[0].author_account_id,
            locked ? 'topic.lock' : 'topic.unlock',
            'Topic lock changed',
            topicId,
          ],
        );
        return mapTopic(result.rows[0]);
      });
    },
  };
}