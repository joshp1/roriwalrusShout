ALTER TABLE registration_invites
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN revoked_at timestamptz;

UPDATE registration_invites
SET expires_at = created_at + interval '1 microsecond';

ALTER TABLE registration_invites
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT registration_invites_expiry_check
    CHECK (expires_at > created_at),
  ADD CONSTRAINT registration_invites_revocation_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at);

DROP INDEX registration_invites_available_idx;

CREATE INDEX registration_invites_available_idx
  ON registration_invites(expires_at, id)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE site_settings
  ADD COLUMN global_registration_token_issued_at timestamptz,
  ADD COLUMN global_registration_token_expires_at timestamptz,
  DROP CONSTRAINT site_settings_global_registration_token_material_check,
  DROP CONSTRAINT site_settings_global_registration_token_enabled_check;

UPDATE site_settings
SET global_registration_token_enabled = false,
  global_registration_token_lookup_digest = NULL,
  global_registration_token_salt = NULL,
  global_registration_token_verifier = NULL,
  global_registration_token_issued_at = NULL,
  global_registration_token_expires_at = NULL;

ALTER TABLE site_settings
  ADD CONSTRAINT site_settings_global_registration_token_material_check CHECK (
    (
      global_registration_token_lookup_digest IS NULL
      AND global_registration_token_salt IS NULL
      AND global_registration_token_verifier IS NULL
      AND global_registration_token_issued_at IS NULL
      AND global_registration_token_expires_at IS NULL
    ) OR (
      global_registration_token_lookup_digest IS NOT NULL
      AND global_registration_token_salt IS NOT NULL
      AND global_registration_token_verifier IS NOT NULL
      AND global_registration_token_issued_at IS NOT NULL
      AND global_registration_token_expires_at IS NOT NULL
      AND global_registration_token_lookup_digest ~ '^[0-9a-f]{64}$'
      AND octet_length(global_registration_token_salt) = 16
      AND octet_length(global_registration_token_verifier) = 32
      AND global_registration_token_expires_at > global_registration_token_issued_at
    )
  ),
  ADD CONSTRAINT site_settings_global_registration_token_enabled_check
    CHECK (NOT global_registration_token_enabled
      OR global_registration_token_lookup_digest IS NOT NULL);