CREATE TABLE direct_message_threads (
  id bigserial PRIMARY KEY,
  title varchar(120) NOT NULL CHECK (char_length(trim(title)) BETWEEN 3 AND 120),
  owner_account_id uuid REFERENCES accounts(id),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE direct_message_members (
  thread_id bigint NOT NULL REFERENCES direct_message_threads(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  invited_by uuid NOT NULL REFERENCES accounts(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (thread_id, account_id)
);

CREATE TABLE direct_messages (
  id bigserial PRIMARY KEY,
  thread_id bigint NOT NULL REFERENCES direct_message_threads(id) ON DELETE CASCADE,
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  body varchar(5000) NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX direct_message_threads_updated_idx
  ON direct_message_threads(updated_at DESC, id DESC);
CREATE INDEX direct_message_members_account_active_idx
  ON direct_message_members(account_id, thread_id) WHERE left_at IS NULL;
CREATE INDEX direct_messages_thread_created_idx
  ON direct_messages(thread_id, created_at, id);

CREATE FUNCTION validate_direct_message_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.locked_at IS NULL AND (
    NEW.owner_account_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM direct_message_members members
      JOIN accounts ON accounts.id = members.account_id
      WHERE members.thread_id = NEW.id
        AND members.account_id = NEW.owner_account_id
        AND members.left_at IS NULL
        AND accounts.membership_status = 'active'
        AND accounts.deleted_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'unlocked direct-message thread requires an active owner';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER direct_message_owner_active
AFTER INSERT OR UPDATE OF owner_account_id, locked_at ON direct_message_threads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_direct_message_owner();

CREATE FUNCTION reject_direct_message_unlock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS NULL THEN
    RAISE EXCEPTION 'direct-message locks are irreversible';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER direct_message_lock_irreversible
BEFORE UPDATE OF locked_at ON direct_message_threads
FOR EACH ROW EXECUTE FUNCTION reject_direct_message_unlock();