CREATE TABLE username_rename_requests (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  current_username varchar(32) NOT NULL,
  requested_username varchar(32) NOT NULL,
  normalized_requested_username varchar(32) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  decided_by_account_id uuid REFERENCES accounts(id),
  decision_reason varchar(500),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT username_rename_requests_current_username_check CHECK (
    current_username = btrim(current_username)
    AND char_length(current_username) BETWEEN 3 AND 32
  ),
  CONSTRAINT username_rename_requests_requested_username_check CHECK (
    requested_username = btrim(requested_username)
    AND char_length(requested_username) BETWEEN 3 AND 32
    AND normalized_requested_username = lower(requested_username)
    AND normalized_requested_username ~ '^[a-z0-9][a-z0-9_-]*( [a-z0-9_-]+)?$'
  ),
  CONSTRAINT username_rename_requests_status_check CHECK (
    status IN ('pending', 'approved', 'rejected')
  ),
  CONSTRAINT username_rename_requests_decision_check CHECK (
    (
      status = 'pending'
      AND decided_at IS NULL
      AND decided_by_account_id IS NULL
      AND decision_reason IS NULL
    ) OR (
      status IN ('approved', 'rejected')
      AND decided_at IS NOT NULL
      AND decided_by_account_id IS NOT NULL
      AND decision_reason IS NOT NULL
      AND decision_reason = btrim(decision_reason)
      AND char_length(decision_reason) BETWEEN 3 AND 500
    )
  )
);

ALTER TABLE username_reservations
  ADD COLUMN rename_request_id bigint UNIQUE
    REFERENCES username_rename_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX username_rename_requests_pending_account_idx
  ON username_rename_requests(account_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX username_rename_requests_pending_target_idx
  ON username_rename_requests(normalized_requested_username)
  WHERE status = 'pending';

CREATE INDEX username_rename_requests_account_requested_idx
  ON username_rename_requests(account_id, requested_at DESC, id DESC);

CREATE INDEX username_rename_requests_status_requested_idx
  ON username_rename_requests(status, requested_at ASC, id ASC);

CREATE TABLE account_username_history (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  username varchar(32) NOT NULL,
  normalized_username varchar(32) NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  rename_request_id bigint NOT NULL UNIQUE
    REFERENCES username_rename_requests(id) ON DELETE RESTRICT,
  CONSTRAINT account_username_history_username_check CHECK (
    username = btrim(username)
    AND char_length(username) BETWEEN 3 AND 32
    AND normalized_username = lower(username)
    AND normalized_username ~ '^[a-z0-9][a-z0-9_-]*( [a-z0-9_-]+)?$'
  ),
  CONSTRAINT account_username_history_interval_check CHECK (ended_at >= started_at)
);

CREATE INDEX account_username_history_account_ended_idx
  ON account_username_history(account_id, ended_at DESC, id DESC);