CREATE TABLE authentication_audit_events (
  id bigserial PRIMARY KEY,
  account_id uuid,
  session_id uuid,
  action varchar(60) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX authentication_audit_account_created_idx
  ON authentication_audit_events(account_id, created_at DESC);

CREATE INDEX authentication_audit_action_created_idx
  ON authentication_audit_events(action, created_at DESC);

CREATE FUNCTION reject_authentication_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authentication audit events are immutable';
END;
$$;

CREATE TRIGGER authentication_audit_events_immutable
BEFORE UPDATE OR DELETE ON authentication_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_authentication_audit_mutation();