ALTER TABLE accounts
  ADD COLUMN username_color_effect varchar(20) NOT NULL DEFAULT 'none',
  ADD COLUMN username_color_effects_unlocked_at timestamptz,
  ADD CONSTRAINT accounts_username_color_effect_check
    CHECK (username_color_effect IN ('none', 'rainbow', 'rainbow-roll')),
  ADD CONSTRAINT accounts_username_color_effect_entitlement_check
    CHECK (username_color_effect = 'none' OR username_color_effects_unlocked_at IS NOT NULL);

CREATE TABLE username_color_unlock_codes (
  id bigserial PRIMARY KEY,
  token_digest char(64) NOT NULL UNIQUE
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  created_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  redeemed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (
    (redeemed_by_account_id IS NULL AND redeemed_at IS NULL)
    OR (redeemed_by_account_id IS NOT NULL AND redeemed_at IS NOT NULL)
  )
);

CREATE INDEX username_color_unlock_codes_available_idx
  ON username_color_unlock_codes(expires_at, id)
  WHERE redeemed_at IS NULL;
