CREATE TABLE shoutbox_streams (
  key varchar(20) PRIMARY KEY,
  label varchar(40) NOT NULL UNIQUE,
  required_permission varchar(40),
  CONSTRAINT shoutbox_streams_policy_check CHECK (
    (key = 'public' AND required_permission IS NULL)
    OR (key = 'staff' AND required_permission = 'shouts.moderate')
  )
);

INSERT INTO shoutbox_streams (key, label, required_permission) VALUES
  ('public', 'Public', NULL),
  ('staff', 'Staff', 'shouts.moderate');

ALTER TABLE shouts
  ADD COLUMN stream_key varchar(20) NOT NULL DEFAULT 'public'
    REFERENCES shoutbox_streams(key);

ALTER TABLE notifications
  ADD COLUMN shout_id bigint REFERENCES shouts(id) ON DELETE CASCADE;

DROP INDEX shouts_active_created_idx;
CREATE INDEX shouts_stream_active_created_idx
  ON shouts (stream_key, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE FUNCTION shoutbox_stream_visible_to(
  viewer_account_id uuid,
  requested_stream_key varchar
) RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT requested_stream_key = 'public'
    OR (
      requested_stream_key = 'staff'
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
                  AND moderator_grants.permission = 'shouts.moderate'
              )
            )
          )
      )
    );
$$;

CREATE FUNCTION shout_visible_to(
  viewer_account_id uuid,
  subject_shout_id bigint
) RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM shouts
    WHERE shouts.id = subject_shout_id
      AND shoutbox_stream_visible_to(viewer_account_id, shouts.stream_key)
  );
$$;