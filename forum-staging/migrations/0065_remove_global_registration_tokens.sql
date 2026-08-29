UPDATE site_settings
SET global_registration_token_enabled = false,
  global_registration_token_lookup_digest = NULL,
  global_registration_token_salt = NULL,
  global_registration_token_verifier = NULL,
  global_registration_token_issued_at = NULL,
  global_registration_token_expires_at = NULL;

ALTER TABLE site_settings
  DROP CONSTRAINT site_settings_global_registration_token_material_check,
  DROP CONSTRAINT site_settings_global_registration_token_enabled_check,
  ADD CONSTRAINT site_settings_global_registration_token_material_check CHECK (
    global_registration_token_lookup_digest IS NULL
    AND global_registration_token_salt IS NULL
    AND global_registration_token_verifier IS NULL
    AND global_registration_token_issued_at IS NULL
    AND global_registration_token_expires_at IS NULL
  ),
  ADD CONSTRAINT site_settings_global_registration_token_enabled_check
    CHECK (global_registration_token_enabled = false);