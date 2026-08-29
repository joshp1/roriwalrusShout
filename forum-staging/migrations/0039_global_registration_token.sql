ALTER TABLE site_settings
  ADD COLUMN global_registration_token_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN global_registration_token_lookup_digest char(64),
  ADD COLUMN global_registration_token_salt bytea,
  ADD COLUMN global_registration_token_verifier bytea;

DO $$
BEGIN
  IF (SELECT count(*) FROM registration_invites WHERE issuer_kind = 'system') <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one system registration credential';
  END IF;
END $$;

DELETE FROM registration_invites WHERE issuer_kind = 'system';

ALTER TABLE site_settings
  ADD CONSTRAINT site_settings_global_registration_token_material_check CHECK (
    (
      global_registration_token_lookup_digest IS NULL
      AND global_registration_token_salt IS NULL
      AND global_registration_token_verifier IS NULL
    ) OR (
      global_registration_token_lookup_digest IS NOT NULL
      AND global_registration_token_salt IS NOT NULL
      AND global_registration_token_verifier IS NOT NULL
      AND global_registration_token_lookup_digest ~ '^[0-9a-f]{64}$'
      AND octet_length(global_registration_token_salt) = 16
      AND octet_length(global_registration_token_verifier) = 32
    )
  ),
  ADD CONSTRAINT site_settings_global_registration_token_enabled_check
    CHECK (NOT global_registration_token_enabled
      OR global_registration_token_lookup_digest IS NOT NULL);