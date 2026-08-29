DROP INDEX accounts_single_goat_role_idx;

ALTER TABLE accounts DROP CONSTRAINT accounts_role_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('member', 'moderator', 'admin', 'goat', 'owner', 'dev'));

DO $$
BEGIN
  IF (
    SELECT count(*) FROM accounts
    WHERE normalized_username = 'mila' AND role = 'admin'
      AND membership_status = 'active' AND deleted_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'expected one active mila administrator';
  END IF;

  IF (
    SELECT count(*) FROM accounts
    WHERE normalized_username = 'bumastis' AND role = 'goat'
      AND membership_status = 'active' AND deleted_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'expected one active bumastis goat';
  END IF;

  UPDATE accounts SET role = 'owner', updated_at = now()
  WHERE normalized_username = 'bumastis';

  UPDATE accounts SET role = 'dev', updated_at = now()
  WHERE normalized_username = 'mila';

  IF (
    SELECT count(*) FROM accounts
    WHERE normalized_username = 'bumastis' AND role = 'owner'
      AND membership_status = 'active' AND deleted_at IS NULL
  ) <> 1 OR (
    SELECT count(*) FROM accounts
    WHERE normalized_username = 'mila' AND role = 'dev'
      AND membership_status = 'active' AND deleted_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'owner and dev assignments failed';
  END IF;
END
$$;

ALTER TABLE accounts DROP CONSTRAINT accounts_role_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('member', 'moderator', 'admin', 'owner', 'dev'));