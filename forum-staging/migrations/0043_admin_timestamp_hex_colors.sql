ALTER TABLE accounts
  DROP CONSTRAINT accounts_timestamp_color_check;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_timestamp_color_check CHECK (
    timestamp_color IN ('default', 'forest', 'red', 'blue', 'gold', 'teal')
    OR timestamp_color ~ '^#[0-9a-f]{6}$'
  );