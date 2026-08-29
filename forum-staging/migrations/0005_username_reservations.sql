ALTER TABLE accounts DROP CONSTRAINT accounts_normalized_username_check;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_normalized_username_check
  CHECK (
    char_length(normalized_username) BETWEEN 3 AND 32
    AND normalized_username ~ '^[a-z0-9][a-z0-9_-]*( [a-z0-9_-]+)?$'
  );

CREATE TABLE username_reservations (
  normalized_username varchar(32) PRIMARY KEY,
  reserved_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO username_reservations (normalized_username)
SELECT normalized_username FROM accounts
ON CONFLICT DO NOTHING;