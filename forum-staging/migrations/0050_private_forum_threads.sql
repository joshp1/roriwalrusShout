ALTER TABLE direct_messages
  DROP CONSTRAINT direct_messages_body_check;

ALTER TABLE direct_messages
  ALTER COLUMN body TYPE varchar(10000),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT direct_messages_body_check
    CHECK (char_length(trim(body)) BETWEEN 1 AND 10000);

UPDATE direct_messages
SET updated_at = created_at;

WITH owned_threads AS (
  SELECT threads.id, successor.account_id AS successor_account_id
  FROM direct_message_threads threads
  JOIN accounts owners ON owners.id = threads.owner_account_id
  LEFT JOIN LATERAL (
    SELECT members.account_id
    FROM direct_message_members members
    JOIN accounts ON accounts.id = members.account_id
    WHERE members.thread_id = threads.id
      AND members.account_id <> threads.owner_account_id
      AND members.left_at IS NULL
      AND accounts.membership_status = 'active'
      AND accounts.deleted_at IS NULL
    ORDER BY members.joined_at, members.account_id
    LIMIT 1
  ) successor ON true
  WHERE threads.locked_at IS NULL
    AND (owners.membership_status <> 'active' OR owners.deleted_at IS NOT NULL)
)
UPDATE direct_message_threads threads
SET owner_account_id = owned_threads.successor_account_id,
  locked_at = CASE
    WHEN owned_threads.successor_account_id IS NULL THEN clock_timestamp()
    ELSE NULL
  END,
  updated_at = clock_timestamp()
FROM owned_threads
WHERE threads.id = owned_threads.id;

CREATE TABLE direct_message_revisions (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  editor_account_id uuid NOT NULL REFERENCES accounts(id),
  body varchar(10000) NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 10000),
  reason varchar(200) NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX direct_message_revisions_message_created_idx
  ON direct_message_revisions(message_id, created_at DESC, id DESC);