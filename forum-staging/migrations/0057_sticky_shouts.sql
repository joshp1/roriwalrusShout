ALTER TABLE shouts
  ADD COLUMN pinned_at timestamptz;

CREATE INDEX shouts_stream_pinned_idx
  ON shouts (stream_key, pinned_at DESC, id DESC)
  WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;