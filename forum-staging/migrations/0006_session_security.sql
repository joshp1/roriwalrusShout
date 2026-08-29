ALTER TABLE sessions
  ADD COLUMN id uuid,
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN user_agent varchar(200);

UPDATE sessions
SET id = gen_random_uuid(), last_seen_at = created_at;

ALTER TABLE sessions
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN last_seen_at SET DEFAULT now();

CREATE UNIQUE INDEX sessions_id_idx ON sessions(id);
CREATE INDEX sessions_account_active_idx
  ON sessions(account_id, last_seen_at DESC, id)
  WHERE revoked_at IS NULL;