UPDATE forum_subforums SET label = 'Just Chat' WHERE key = 'public';

ALTER TABLE forum_subforums DROP CONSTRAINT forum_subforums_policy_check;
ALTER TABLE forum_subforums ADD CONSTRAINT forum_subforums_policy_check CHECK (
  (key IN ('public', 'art-3d', 'art-2d', 'stories') AND required_permission IS NULL)
  OR (key = 'moderation' AND required_permission = 'posts.moderate')
);

INSERT INTO forum_subforums (key, label, required_permission) VALUES
  ('art-3d', '3D Renders', NULL),
  ('art-2d', '2D Art', NULL),
  ('stories', 'Stories & Writing', NULL);

CREATE OR REPLACE FUNCTION forum_subforum_visible_to(
  viewer_account_id uuid,
  requested_subforum_key varchar
) RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM forum_subforums
    WHERE forum_subforums.key = requested_subforum_key
      AND forum_subforums.required_permission IS NULL
  ) OR (
    requested_subforum_key = 'moderation'
    AND EXISTS (
      SELECT 1 FROM accounts viewers
      WHERE viewers.id = viewer_account_id
        AND viewers.membership_status = 'active'
        AND viewers.deleted_at IS NULL
        AND (
          viewers.role IN ('admin', 'dev', 'owner')
          OR (
            viewers.role = 'moderator'
            AND EXISTS (
              SELECT 1 FROM moderator_grants
              WHERE moderator_grants.account_id = viewers.id
                AND moderator_grants.permission = 'posts.moderate'
            )
          )
        )
    )
  );
$$;

ALTER TABLE posts ALTER COLUMN body TYPE varchar(50000);
ALTER TABLE post_revisions ALTER COLUMN body TYPE varchar(50000);
