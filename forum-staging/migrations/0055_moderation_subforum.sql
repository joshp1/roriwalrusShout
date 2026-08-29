CREATE TABLE forum_subforums (
  key varchar(20) PRIMARY KEY,
  label varchar(40) NOT NULL UNIQUE,
  required_permission varchar(40),
  CONSTRAINT forum_subforums_policy_check CHECK (
    (key = 'public' AND required_permission IS NULL)
    OR (key = 'moderation' AND required_permission = 'posts.moderate')
  )
);

INSERT INTO forum_subforums (key, label, required_permission) VALUES
  ('public', 'Public', NULL),
  ('moderation', 'Moderation', 'posts.moderate');

ALTER TABLE topics
  ADD COLUMN subforum_key varchar(20) NOT NULL DEFAULT 'public'
    REFERENCES forum_subforums(key);

ALTER TABLE notifications
  ADD COLUMN forum_topic_id bigint REFERENCES topics(id) ON DELETE CASCADE;

DROP INDEX topics_activity_idx;
CREATE INDEX topics_subforum_activity_idx
  ON topics(subforum_key, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE FUNCTION forum_subforum_visible_to(
  viewer_account_id uuid,
  requested_subforum_key varchar
) RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT requested_subforum_key = 'public'
    OR (
      requested_subforum_key = 'moderation'
      AND EXISTS (
        SELECT 1
        FROM accounts viewers
        WHERE viewers.id = viewer_account_id
          AND viewers.membership_status = 'active'
          AND viewers.deleted_at IS NULL
          AND (
            viewers.role IN ('admin', 'dev', 'owner')
            OR (
              viewers.role = 'moderator'
              AND EXISTS (
                SELECT 1
                FROM moderator_grants
                WHERE moderator_grants.account_id = viewers.id
                  AND moderator_grants.permission = 'posts.moderate'
              )
            )
          )
      )
    );
$$;

CREATE FUNCTION forum_topic_visible_to(
  viewer_account_id uuid,
  subject_topic_id bigint
) RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM topics
    WHERE topics.id = subject_topic_id
      AND forum_subforum_visible_to(viewer_account_id, topics.subforum_key)
  );
$$;