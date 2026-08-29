CREATE SEQUENCE shout_sync_cursor_sequence;

ALTER TABLE shouts
  ADD COLUMN sync_cursor bigint;

UPDATE shouts
SET sync_cursor = nextval('shout_sync_cursor_sequence');

ALTER TABLE shouts
  ALTER COLUMN sync_cursor SET DEFAULT nextval('shout_sync_cursor_sequence'),
  ALTER COLUMN sync_cursor SET NOT NULL;

ALTER SEQUENCE shout_sync_cursor_sequence
  OWNED BY shouts.sync_cursor;

CREATE UNIQUE INDEX shouts_sync_cursor_idx
  ON shouts (sync_cursor);