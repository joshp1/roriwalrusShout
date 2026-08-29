CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY,
  challenge text NOT NULL UNIQUE CHECK (
    char_length(challenge) BETWEEN 32 AND 128
    AND challenge ~ '^[A-Za-z0-9_-]+$'
  ),
  purpose text NOT NULL CHECK (purpose IN ('authentication', 'registration')),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  CHECK (
    (purpose = 'authentication' AND account_id IS NULL AND session_id IS NULL)
    OR (purpose = 'registration' AND account_id IS NOT NULL AND session_id IS NOT NULL)
  )
);

CREATE INDEX webauthn_challenges_expiry_idx
  ON webauthn_challenges (expires_at);

CREATE UNIQUE INDEX webauthn_registration_challenge_owner_idx
  ON webauthn_challenges (account_id, session_id)
  WHERE purpose = 'registration';

CREATE TABLE webauthn_credentials (
  id text PRIMARY KEY CHECK (
    char_length(id) BETWEEN 1 AND 1364
    AND id ~ '^[A-Za-z0-9_-]+$'
  ),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 1 AND 4096),
  counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 9007199254740991),
  transports text[] NOT NULL DEFAULT ARRAY[]::text[],
  device_type text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL,
  label varchar(80) NOT NULL CHECK (
    char_length(label) BETWEEN 1 AND 80
    AND label = btrim(label)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX webauthn_credentials_account_idx
  ON webauthn_credentials (account_id, created_at DESC, id);

ALTER TABLE sessions
  ADD COLUMN authentication_method varchar(16) NOT NULL DEFAULT 'password'
    CHECK (authentication_method IN ('password', 'passkey')),
  ADD COLUMN passkey_credential_id text
    REFERENCES webauthn_credentials(id) ON DELETE SET NULL;

CREATE INDEX sessions_passkey_credential_idx
  ON sessions (passkey_credential_id)
  WHERE revoked_at IS NULL AND passkey_credential_id IS NOT NULL;