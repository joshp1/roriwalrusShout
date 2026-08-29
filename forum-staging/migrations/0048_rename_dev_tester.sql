DO $$
DECLARE
  tester_id uuid;
BEGIN
  SELECT id INTO tester_id
  FROM accounts
  WHERE normalized_username = 'visual_tester';

  IF tester_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM accounts
      WHERE normalized_username = 'dev-bot'
        AND username = 'dev-bot'
        AND role = 'dev'
        AND visible_to_role = 'dev'
        AND deleted_at IS NULL
    ) THEN
      RETURN;
    END IF;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM accounts
    WHERE id = tester_id
      AND username = 'Visual_Tester'
      AND role = 'dev'
      AND visible_to_role = 'dev'
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'unexpected Visual_Tester identity';
  END IF;

  IF EXISTS (SELECT 1 FROM accounts WHERE normalized_username = 'dev-bot')
    OR EXISTS (SELECT 1 FROM username_reservations WHERE normalized_username = 'dev-bot') THEN
    RAISE EXCEPTION 'dev-bot identity is unavailable';
  END IF;

  INSERT INTO username_reservations (normalized_username) VALUES ('dev-bot');

  UPDATE accounts
  SET username = 'dev-bot', normalized_username = 'dev-bot', display_name = 'dev-bot',
    updated_at = now()
  WHERE id = tester_id;

  DELETE FROM username_reservations
  WHERE normalized_username = 'visual_tester';

  UPDATE sessions
  SET revoked_at = now()
  WHERE account_id = tester_id AND revoked_at IS NULL;

  INSERT INTO authentication_audit_events (account_id, action, details)
  VALUES (
    tester_id,
    'auth.dev_tester.renamed',
    '{"from":"Visual_Tester","to":"dev-bot"}'::jsonb
  );
END $$;