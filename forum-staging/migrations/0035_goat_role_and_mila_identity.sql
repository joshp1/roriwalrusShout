ALTER TABLE accounts DROP CONSTRAINT accounts_role_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_role_check CHECK (role IN ('member', 'moderator', 'admin', 'goat'));

CREATE UNIQUE INDEX accounts_single_goat_role_idx ON accounts (role)
  WHERE role = 'goat';

DO $$
BEGIN
  IF (
    SELECT count(*) FROM accounts
    WHERE normalized_username = 'admin' AND role = 'admin'
      AND membership_status = 'active' AND deleted_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'expected one active admin identity';
  END IF;

  IF EXISTS (SELECT 1 FROM accounts WHERE normalized_username = 'mila')
    OR EXISTS (SELECT 1 FROM username_reservations WHERE normalized_username = 'mila') THEN
    RAISE EXCEPTION 'mila identity is unavailable';
  END IF;

  IF (
    SELECT count(*) FROM accounts
    WHERE normalized_username = 'bumastis' AND role = 'admin'
      AND membership_status = 'active' AND deleted_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'expected one active bumastis administrator';
  END IF;

  INSERT INTO username_reservations (normalized_username) VALUES ('mila');

  UPDATE accounts
  SET username = 'mila', normalized_username = 'mila', display_name = 'mila', updated_at = now()
  WHERE normalized_username = 'admin';

  UPDATE accounts SET role = 'goat', updated_at = now()
  WHERE normalized_username = 'bumastis';
END
$$;