ALTER TABLE accounts
  ADD COLUMN timestamp_color varchar(16) NOT NULL DEFAULT 'default',
  ADD CONSTRAINT accounts_timestamp_color_check CHECK (
    timestamp_color IN ('default', 'forest', 'red', 'blue', 'gold', 'teal')
  );

UPDATE accounts
SET timestamp_color = 'blue', updated_at = now()
WHERE normalized_username IN ('bumastis', 'mila');