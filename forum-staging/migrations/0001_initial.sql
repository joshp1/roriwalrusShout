CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  normalized_email text NOT NULL UNIQUE,
  username varchar(32) NOT NULL,
  normalized_username varchar(32) NOT NULL,
  display_name varchar(40) NOT NULL,
  role varchar(20) NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  avatar_content_type varchar(20),
  avatar_data bytea,
  avatar_updated_at timestamptz,
  theme varchar(8) NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  shoutbox_enabled boolean NOT NULL DEFAULT true,
  shoutbox_muted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_digest char(64) PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_digest char(64) PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_digest char(64) PRIMARY KEY,
  csrf_digest char(64) NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_account_id_idx ON sessions(account_id);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  action varchar(32) NOT NULL,
  subject_digest char(64) NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL,
  PRIMARY KEY (action, subject_digest)
);

CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message varchar(280) NOT NULL,
  href varchar(300) NOT NULL DEFAULT '/',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_account_created_idx
  ON notifications(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shouts (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shouts_created_at_idx ON shouts(created_at DESC);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role varchar(20) NOT NULL DEFAULT 'member';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_content_type varchar(20);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_data bytea;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS username varchar(32);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS normalized_username varchar(32);

WITH prepared AS (
  SELECT
    id,
    display_name,
    CASE
      WHEN lower(display_name) ~ '^[a-z0-9][a-z0-9_-]{2,31}$' THEN lower(display_name)
      ELSE 'user_' || left(replace(id::text, '-', ''), 12)
    END AS base_username
  FROM accounts
  WHERE username IS NULL OR normalized_username IS NULL
), ranked AS (
  SELECT
    id,
    display_name,
    base_username,
    row_number() OVER (PARTITION BY base_username ORDER BY id) AS duplicate_number
  FROM prepared
), resolved AS (
  SELECT
    id,
    CASE
      WHEN duplicate_number = 1 THEN base_username
      ELSE left(base_username, 23) || '_' || left(replace(id::text, '-', ''), 8)
    END AS normalized_username,
    CASE
      WHEN duplicate_number = 1
        AND display_name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$' THEN display_name
      WHEN duplicate_number = 1 THEN base_username
      ELSE left(base_username, 23) || '_' || left(replace(id::text, '-', ''), 8)
    END AS username
  FROM ranked
)
UPDATE accounts
SET username = resolved.username, normalized_username = resolved.normalized_username
FROM resolved
WHERE accounts.id = resolved.id;

ALTER TABLE accounts ALTER COLUMN username SET NOT NULL;
ALTER TABLE accounts ALTER COLUMN normalized_username SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_normalized_username_idx
  ON accounts(normalized_username);

DO $$
BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_role_check CHECK (role IN ('member', 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_normalized_username_check
    CHECK (normalized_username ~ '^[a-z0-9][a-z0-9_-]{2,31}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;