ALTER TABLE accounts DROP CONSTRAINT accounts_username_color_check;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_username_color_check
  CHECK (
    username_color IN ('default', 'forest', 'red', 'blue', 'gold', 'teal')
    OR username_color ~ '^#[0-9a-f]{6}$'
  );