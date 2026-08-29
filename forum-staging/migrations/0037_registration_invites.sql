CREATE TABLE registration_invites (
  id bigserial PRIMARY KEY,
  token_lookup_digest char(64) NOT NULL UNIQUE
    CHECK (token_lookup_digest ~ '^[0-9a-f]{64}$'),
  token_salt bytea NOT NULL CHECK (octet_length(token_salt) = 16),
  token_verifier bytea NOT NULL CHECK (octet_length(token_verifier) = 32),
  issuer_kind varchar(10) NOT NULL CHECK (issuer_kind IN ('system', 'account')),
  issuer_account_id uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_by_account_id uuid REFERENCES accounts(id),
  redeemed_at timestamptz,
  CHECK (
    (issuer_kind = 'system' AND issuer_account_id IS NULL)
    OR (issuer_kind = 'account' AND issuer_account_id IS NOT NULL)
  ),
  CHECK (
    (redeemed_by_account_id IS NULL AND redeemed_at IS NULL)
    OR (redeemed_by_account_id IS NOT NULL AND redeemed_at IS NOT NULL)
  )
);

CREATE INDEX registration_invites_available_idx
  ON registration_invites(id)
  WHERE redeemed_at IS NULL;

INSERT INTO registration_invites (
  token_lookup_digest, token_salt, token_verifier, issuer_kind
) VALUES (
  'dd9a26eac440f093c2017bfdf88b22e4a56cade5082eeb284da28a17ce19f583',
  decode('b6d0d7fbc936c1ff6634c6d6c477dd55', 'hex'),
  decode('449569d02803fecd2a7ff97ef7b5277dca642dbdfbc4dd11bcb477d5c9314551', 'hex'),
  'system'
);