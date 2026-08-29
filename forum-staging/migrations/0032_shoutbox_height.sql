ALTER TABLE accounts
  ADD COLUMN shoutbox_height_lines smallint NOT NULL DEFAULT 18
    CHECK (shoutbox_height_lines BETWEEN 18 AND 60);