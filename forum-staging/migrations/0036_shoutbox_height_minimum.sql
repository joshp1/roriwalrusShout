ALTER TABLE accounts DROP CONSTRAINT accounts_shoutbox_height_lines_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_shoutbox_height_lines_check
  CHECK (shoutbox_height_lines BETWEEN 7 AND 60);