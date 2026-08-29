CREATE TABLE login_backoffs (
  subject_digest char(64) PRIMARY KEY,
  failure_count integer NOT NULL CHECK (failure_count BETWEEN 1 AND 13),
  last_failed_at timestamptz NOT NULL,
  blocked_until timestamptz NOT NULL CHECK (blocked_until >= last_failed_at)
);

CREATE INDEX login_backoffs_last_failed_idx
  ON login_backoffs(last_failed_at);