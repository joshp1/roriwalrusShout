ALTER TABLE site_settings
  ADD COLUMN shoutbox_visibility_mode varchar(10) NOT NULL DEFAULT 'count'
    CHECK (shoutbox_visibility_mode IN ('time', 'count')),
  ADD COLUMN shoutbox_visibility_hours integer NOT NULL DEFAULT 24
    CHECK (shoutbox_visibility_hours BETWEEN 12 AND 720),
  ADD COLUMN shoutbox_visibility_count integer NOT NULL DEFAULT 50
    CHECK (shoutbox_visibility_count BETWEEN 10 AND 200);

CREATE INDEX shouts_active_created_idx
  ON shouts (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;