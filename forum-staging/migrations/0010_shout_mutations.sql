ALTER TABLE shouts
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at timestamptz;

CREATE TABLE shout_revisions (
  id bigserial PRIMARY KEY,
  shout_id bigint NOT NULL REFERENCES shouts(id) ON DELETE CASCADE,
  actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  action varchar(10) NOT NULL CHECK (action IN ('edit', 'delete')),
  body varchar(500) NOT NULL,
  reason varchar(200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shout_revisions_shout_created_idx
  ON shout_revisions (shout_id, created_at DESC, id DESC);

CREATE TRIGGER shout_revisions_immutable
BEFORE UPDATE OR DELETE ON shout_revisions
FOR EACH ROW EXECUTE FUNCTION reject_moderation_audit_mutation();