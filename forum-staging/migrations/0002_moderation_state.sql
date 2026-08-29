ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_role_check CHECK (role IN ('member', 'moderator', 'admin'));

ALTER TABLE accounts
  ADD COLUMN membership_status varchar(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN force_password_change boolean NOT NULL DEFAULT false,
  ADD COLUMN slowdown_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN deleted_at timestamptz;

UPDATE accounts SET membership_status = 'active';

ALTER TABLE accounts
  ADD CONSTRAINT accounts_membership_status_check
    CHECK (membership_status IN ('pending', 'active', 'rejected', 'suspended', 'revoked', 'deleted')),
  ADD CONSTRAINT accounts_slowdown_ms_check CHECK (slowdown_ms BETWEEN 0 AND 300000);

CREATE INDEX accounts_membership_status_idx ON accounts(membership_status, created_at DESC);

CREATE TABLE moderator_grants (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  permission varchar(40) NOT NULL CHECK (
    permission IN ('posts.moderate', 'shouts.moderate', 'users.moderate', 'users.view')
  ),
  granted_by uuid NOT NULL REFERENCES accounts(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, permission)
);

CREATE TABLE moderation_audit_events (
  id bigserial PRIMARY KEY,
  actor_account_id uuid,
  target_account_id uuid,
  action varchar(60) NOT NULL,
  reason varchar(500) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_audit_target_created_idx
  ON moderation_audit_events(target_account_id, created_at DESC);

CREATE FUNCTION reject_moderation_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation audit events are immutable';
END;
$$;

CREATE TRIGGER moderation_audit_events_immutable
BEFORE UPDATE OR DELETE ON moderation_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_moderation_audit_mutation();