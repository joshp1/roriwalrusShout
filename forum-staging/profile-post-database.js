const contentDefinitions = Object.freeze({
  profile_post: Object.freeze({
    auditPrefix: 'profile.post',
    revisionForeignKey: 'profile_post_id',
    revisionTable: 'profile_post_revisions',
    table: 'profile_posts',
  }),
  profile_post_comment: Object.freeze({
    auditPrefix: 'profile.post.comment',
    revisionForeignKey: 'profile_post_comment_id',
    revisionTable: 'profile_post_comment_revisions',
    table: 'profile_post_comments',
  }),
  profile_visitor_post: Object.freeze({
    auditPrefix: 'profile.visitor_post',
    revisionForeignKey: 'profile_visitor_post_id',
    revisionTable: 'profile_visitor_post_revisions',
    table: 'profile_visitor_posts',
  }),
  profile_visitor_post_comment: Object.freeze({
    auditPrefix: 'profile.visitor_post.comment',
    revisionForeignKey: 'profile_visitor_post_comment_id',
    revisionTable: 'profile_visitor_post_comment_revisions',
    table: 'profile_visitor_post_comments',
  }),
});

function mapContent(row) {
  return {
    author: row.display_name,
    authorId: row.author_account_id,
    authorUsername: row.username,
    avatarContentType: row.avatar_updated_at ? row.avatar_content_type : null,
    avatarUrl: row.avatar_updated_at
      ? `/api/avatars/${row.author_account_id}?v=${new Date(row.avatar_updated_at).getTime()}`
      : null,
    body: row.deleted_at ? null : row.body,
    createdAt: row.created_at,
    deleted: Boolean(row.deleted_at),
    id: String(row.id),
    profileAccountId: row.profile_account_id,
    updatedAt: row.updated_at,
    usernameColor: row.username_color ?? 'default',
    usernameColorEffect: row.username_color_effect ?? 'none',
    visibleToRole: row.visible_to_role ?? null,
  };
}

async function recordAudit(client, { action, actorId, contentId, profileId, targetId }) {
  await client.query(
    `INSERT INTO moderation_audit_events (
       actor_account_id, target_account_id, action, reason, details
     ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      actorId,
      targetId,
      action,
      'Profile content lifecycle',
      JSON.stringify({ contentId: String(contentId), profileAccountId: profileId }),
    ],
  );
}

function contentSelection(kind, { forUpdate = false } = {}) {
  const lock = forUpdate ? `\n     FOR UPDATE OF content` : '';
  if (kind === 'profile_post') {
    return `SELECT content.*, content.profile_account_id AS author_account_id,
       authors.display_name, authors.username, authors.username_color,
       authors.username_color_effect, authors.visible_to_role,
       authors.avatar_content_type, authors.avatar_updated_at
     FROM profile_posts content
     JOIN accounts authors ON authors.id = content.profile_account_id
     WHERE content.id = $1
       AND account_visible_to($2, content.profile_account_id)${lock}`;
  }
  if (kind === 'profile_post_comment') {
    return `SELECT content.*, posts.profile_account_id,
       content.author_account_id,
       authors.display_name, authors.username, authors.username_color,
       authors.username_color_effect, authors.visible_to_role,
       authors.avatar_content_type, authors.avatar_updated_at
     FROM profile_post_comments content
     JOIN profile_posts posts ON posts.id = content.profile_post_id
     JOIN accounts authors ON authors.id = content.author_account_id
     WHERE content.id = $1 AND posts.deleted_at IS NULL
       AND account_visible_to($2, posts.profile_account_id)
       AND account_visible_to($2, content.author_account_id)${lock}`;
  }
  if (kind === 'profile_visitor_post') {
    return `SELECT content.*, content.author_account_id,
       authors.display_name, authors.username, authors.username_color,
       authors.username_color_effect, authors.visible_to_role,
       authors.avatar_content_type, authors.avatar_updated_at
     FROM profile_visitor_posts content
     JOIN accounts profiles ON profiles.id = content.profile_account_id
     JOIN accounts authors ON authors.id = content.author_account_id
     WHERE content.id = $1
       AND (content.profile_account_id = $2 OR profiles.profile_visitor_area_visible)
       AND account_visible_to($2, content.profile_account_id)
       AND account_visible_to($2, content.author_account_id)${lock}`;
  }
  return `SELECT content.*, posts.profile_account_id,
     content.author_account_id,
     authors.display_name, authors.username, authors.username_color,
     authors.username_color_effect, authors.visible_to_role,
     authors.avatar_content_type, authors.avatar_updated_at
   FROM profile_visitor_post_comments content
   JOIN profile_visitor_posts posts ON posts.id = content.profile_visitor_post_id
   JOIN accounts profiles ON profiles.id = posts.profile_account_id
   JOIN accounts authors ON authors.id = content.author_account_id
   WHERE content.id = $1 AND posts.deleted_at IS NULL
     AND (posts.profile_account_id = $2 OR profiles.profile_visitor_area_visible)
     AND account_visible_to($2, posts.profile_account_id)
     AND account_visible_to($2, posts.author_account_id)
     AND account_visible_to($2, content.author_account_id)${lock}`;
}

export function createProfilePostRepository(pool) {
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

  async function selectContent(client, kind, id, viewerId, options) {
    const result = await client.query(contentSelection(kind, options), [id, viewerId]);
    return result.rows[0] ?? null;
  }

  async function selectProfilePost(client, id, viewerId) {
    const row = await selectContent(client, 'profile_post', id, viewerId);
    return row ? mapContent(row) : null;
  }

  async function selectProfilePostComment(client, id, viewerId) {
    const row = await selectContent(client, 'profile_post_comment', id, viewerId);
    return row ? mapContent(row) : null;
  }

  async function selectProfileVisitorPost(client, id, viewerId) {
    const row = await selectContent(client, 'profile_visitor_post', id, viewerId);
    return row ? mapContent(row) : null;
  }

  async function selectProfileVisitorPostComment(client, id, viewerId) {
    const row = await selectContent(client, 'profile_visitor_post_comment', id, viewerId);
    return row ? mapContent(row) : null;
  }

  return {
    async createProfilePost({ actorId, body, createdAt, profileId }) {
      return withTransaction(async (client) => {
        const access = await client.query(
          `SELECT id FROM accounts
           WHERE id = $1 AND id = $2
             AND membership_status = 'active' AND deleted_at IS NULL
           FOR UPDATE`,
          [profileId, actorId],
        );
        if (!access.rows[0]) return null;
        const inserted = await client.query(
          `INSERT INTO profile_posts (
             profile_account_id, body, created_at, updated_at
           ) VALUES ($1, $2, $3, $3) RETURNING id`,
          [profileId, body, createdAt],
        );
        const id = inserted.rows[0].id;
        await recordAudit(client, {
          action: 'profile.post.create',
          actorId,
          contentId: id,
          profileId,
          targetId: profileId,
        });
        await client.query(
          `INSERT INTO notifications (account_id, message, href)
           SELECT follows.follower_account_id,
             actor.username || ' posted on their profile',
             '/profile?username=' || actor.username
           FROM account_follows follows
           JOIN accounts recipients ON recipients.id = follows.follower_account_id
           JOIN accounts actor ON actor.id = $1
           WHERE follows.followed_account_id = $1
             AND recipients.membership_status = 'active'
             AND recipients.deleted_at IS NULL
             AND account_visible_to(recipients.id, actor.id)`,
          [actorId],
        );
        return selectProfilePost(client, id, actorId);
      });
    },

    async createProfilePostComment({ actorId, body, createdAt, postId }) {
      return withTransaction(async (client) => {
        const access = await client.query(
          `SELECT posts.profile_account_id
           FROM profile_posts posts
           WHERE posts.id = $1 AND posts.deleted_at IS NULL
             AND account_visible_to($2, posts.profile_account_id)
             AND account_visible_to(posts.profile_account_id, $2)
           FOR UPDATE OF posts`,
          [postId, actorId],
        );
        if (!access.rows[0]) return null;
        const profileId = access.rows[0].profile_account_id;
        const inserted = await client.query(
          `INSERT INTO profile_post_comments (
             profile_post_id, profile_account_id, author_account_id,
             body, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [postId, profileId, actorId, body, createdAt],
        );
        const id = inserted.rows[0].id;
        await recordAudit(client, {
          action: 'profile.post.comment.create',
          actorId,
          contentId: id,
          profileId,
          targetId: profileId,
        });
        return selectProfilePostComment(client, id, actorId);
      });
    },

    async createProfileVisitorPost({ actorId, body, createdAt, profileId }) {
      return withTransaction(async (client) => {
        const access = await client.query(
          `SELECT profiles.id
           FROM accounts profiles
           WHERE profiles.id = $1 AND profiles.id <> $2
             AND profiles.membership_status = 'active'
             AND profiles.deleted_at IS NULL
             AND profiles.profile_visitor_area_visible
             AND account_visible_to($2, profiles.id)
             AND account_visible_to(profiles.id, $2)
           FOR UPDATE OF profiles`,
          [profileId, actorId],
        );
        if (!access.rows[0]) return null;
        const inserted = await client.query(
          `INSERT INTO profile_visitor_posts (
             profile_account_id, author_account_id, body, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
          [profileId, actorId, body, createdAt],
        );
        const id = inserted.rows[0].id;
        await recordAudit(client, {
          action: 'profile.visitor_post.create',
          actorId,
          contentId: id,
          profileId,
          targetId: profileId,
        });
        return selectProfileVisitorPost(client, id, actorId);
      });
    },

    async createProfileVisitorPostComment({ actorId, body, createdAt, postId }) {
      return withTransaction(async (client) => {
        const access = await client.query(
          `SELECT posts.profile_account_id
           FROM profile_visitor_posts posts
           JOIN accounts profiles ON profiles.id = posts.profile_account_id
           WHERE posts.id = $1 AND posts.deleted_at IS NULL
             AND (posts.profile_account_id = $2 OR profiles.profile_visitor_area_visible)
             AND account_visible_to($2, posts.profile_account_id)
             AND account_visible_to(posts.profile_account_id, $2)
             AND account_visible_to($2, posts.author_account_id)
           FOR UPDATE OF posts`,
          [postId, actorId],
        );
        if (!access.rows[0]) return null;
        const profileId = access.rows[0].profile_account_id;
        const inserted = await client.query(
          `INSERT INTO profile_visitor_post_comments (
             profile_visitor_post_id, profile_account_id, author_account_id,
             body, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [postId, profileId, actorId, body, createdAt],
        );
        const id = inserted.rows[0].id;
        await recordAudit(client, {
          action: 'profile.visitor_post.comment.create',
          actorId,
          contentId: id,
          profileId,
          targetId: profileId,
        });
        return selectProfileVisitorPostComment(client, id, actorId);
      });
    },

    async deleteProfileContent({ actorId, deletedAt, id, kind }) {
      const definition = contentDefinitions[kind];
      if (!definition) return { status: 'not_found' };
      return withTransaction(async (client) => {
        const current = await selectContent(client, kind, id, actorId, { forUpdate: true });
        if (!current || current.deleted_at) return { status: 'not_found' };
        const author = current.author_account_id === actorId;
        const profileOwner = current.profile_account_id === actorId;
        if (!author && (kind === 'profile_post' || !profileOwner)) {
          return { status: 'denied' };
        }
        const reason = author ? 'Author delete' : 'Profile owner delete';
        await client.query(
          `INSERT INTO ${definition.revisionTable} (
             ${definition.revisionForeignKey}, editor_account_id, body, reason, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [id, actorId, current.body, reason, deletedAt],
        );
        await client.query(
          `UPDATE ${definition.table} SET deleted_at = $2, updated_at = $2 WHERE id = $1`,
          [id, deletedAt],
        );
        await recordAudit(client, {
          action: `${definition.auditPrefix}.delete`,
          actorId,
          contentId: id,
          profileId: current.profile_account_id,
          targetId: current.author_account_id,
        });
        return {
          item: { deleted: true, id: String(id), updatedAt: deletedAt },
          status: 'ok',
        };
      });
    },

    async editProfileContent({ actorId, body, expectedUpdatedAt, id, kind, updatedAt }) {
      const definition = contentDefinitions[kind];
      if (!definition) return { status: 'not_found' };
      return withTransaction(async (client) => {
        const current = await selectContent(client, kind, id, actorId, { forUpdate: true });
        if (!current || current.deleted_at) return { status: 'not_found' };
        if (current.author_account_id !== actorId) return { status: 'denied' };
        if (new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
          return { status: 'conflict' };
        }
        await client.query(
          `INSERT INTO ${definition.revisionTable} (
             ${definition.revisionForeignKey}, editor_account_id, body, reason, created_at
           ) VALUES ($1, $2, $3, 'Author edit', $4)`,
          [id, actorId, current.body, updatedAt],
        );
        await client.query(
          `UPDATE ${definition.table} SET body = $2, updated_at = $3 WHERE id = $1`,
          [id, body, updatedAt],
        );
        await recordAudit(client, {
          action: `${definition.auditPrefix}.edit`,
          actorId,
          contentId: id,
          profileId: current.profile_account_id,
          targetId: current.author_account_id,
        });
        const item = await selectContent(client, kind, id, actorId);
        return { item: mapContent(item), status: 'ok' };
      });
    },

    async listProfilePostComments(viewerId, postId, limit, offset) {
      const access = await pool.query(
        `SELECT posts.id FROM profile_posts posts
         WHERE posts.id = $1 AND posts.deleted_at IS NULL
           AND account_visible_to($2, posts.profile_account_id)`,
        [postId, viewerId],
      );
      if (!access.rows[0]) return null;
      const result = await pool.query(
        `SELECT comments.*, comments.author_account_id,
           authors.display_name, authors.username, authors.username_color,
           authors.username_color_effect, authors.visible_to_role,
           authors.avatar_content_type, authors.avatar_updated_at
         FROM profile_post_comments comments
         JOIN accounts authors ON authors.id = comments.author_account_id
         WHERE comments.profile_post_id = $1 AND comments.deleted_at IS NULL
           AND account_visible_to($2, comments.author_account_id)
         ORDER BY comments.created_at, comments.id
         LIMIT $3 OFFSET $4`,
        [postId, viewerId, limit, offset],
      );
      return result.rows.map(mapContent);
    },

    async listProfilePosts(viewerId, profileId, limit, offset) {
      const result = await pool.query(
        `SELECT posts.*, posts.profile_account_id AS author_account_id,
           authors.display_name, authors.username, authors.username_color,
           authors.username_color_effect, authors.visible_to_role,
           authors.avatar_content_type, authors.avatar_updated_at
         FROM profile_posts posts
         JOIN accounts authors ON authors.id = posts.profile_account_id
         WHERE posts.profile_account_id = $2 AND posts.deleted_at IS NULL
           AND account_visible_to($1, posts.profile_account_id)
         ORDER BY posts.created_at DESC, posts.id DESC
         LIMIT $3 OFFSET $4`,
        [viewerId, profileId, limit, offset],
      );
      return result.rows.map(mapContent);
    },

    async listProfileVisitorPosts(viewerId, profileId, limit, offset) {
      const access = await pool.query(
        `SELECT profiles.profile_visitor_area_visible
         FROM accounts profiles
         WHERE profiles.id = $2
           AND profiles.membership_status = 'active'
           AND profiles.deleted_at IS NULL
           AND account_visible_to($1, profiles.id)`,
        [viewerId, profileId],
      );
      if (!access.rows[0]
        || (!access.rows[0].profile_visitor_area_visible && viewerId !== profileId)) {
        return null;
      }
      const result = await pool.query(
        `SELECT posts.*, posts.author_account_id,
           authors.display_name, authors.username, authors.username_color,
           authors.username_color_effect, authors.visible_to_role,
           authors.avatar_content_type, authors.avatar_updated_at
         FROM profile_visitor_posts posts
         JOIN accounts authors ON authors.id = posts.author_account_id
         WHERE posts.profile_account_id = $2 AND posts.deleted_at IS NULL
           AND account_visible_to($1, posts.author_account_id)
         ORDER BY posts.created_at DESC, posts.id DESC
         LIMIT $3 OFFSET $4`,
        [viewerId, profileId, limit, offset],
      );
      return result.rows.map(mapContent);
    },

    async listProfileVisitorPostComments(viewerId, postId, limit, offset) {
      const access = await pool.query(
        `SELECT posts.id
         FROM profile_visitor_posts posts
         JOIN accounts profiles ON profiles.id = posts.profile_account_id
         WHERE posts.id = $1 AND posts.deleted_at IS NULL
           AND (posts.profile_account_id = $2 OR profiles.profile_visitor_area_visible)
           AND account_visible_to($2, posts.profile_account_id)
           AND account_visible_to($2, posts.author_account_id)`,
        [postId, viewerId],
      );
      if (!access.rows[0]) return null;
      const result = await pool.query(
        `SELECT comments.*, comments.author_account_id,
           authors.display_name, authors.username, authors.username_color,
           authors.username_color_effect, authors.visible_to_role,
           authors.avatar_content_type, authors.avatar_updated_at
         FROM profile_visitor_post_comments comments
         JOIN accounts authors ON authors.id = comments.author_account_id
         WHERE comments.profile_visitor_post_id = $1 AND comments.deleted_at IS NULL
           AND account_visible_to($2, comments.author_account_id)
         ORDER BY comments.created_at, comments.id
         LIMIT $3 OFFSET $4`,
        [postId, viewerId, limit, offset],
      );
      return result.rows.map(mapContent);
    },
  };
}