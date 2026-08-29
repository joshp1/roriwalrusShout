ALTER TABLE accounts
  ADD COLUMN rules_version varchar(32),
  ADD COLUMN rules_agreed_at timestamptz,
  ADD CONSTRAINT accounts_rules_agreement_check CHECK (
    (rules_version IS NULL AND rules_agreed_at IS NULL)
    OR (
      rules_version IS NOT NULL
      AND rules_agreed_at IS NOT NULL
      AND char_length(rules_version) BETWEEN 1 AND 32
      AND rules_version = btrim(rules_version)
    )
  );