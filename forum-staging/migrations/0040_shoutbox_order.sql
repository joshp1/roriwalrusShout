ALTER TABLE accounts
  ADD COLUMN shoutbox_order varchar(12) NOT NULL DEFAULT 'oldest-first'
    CHECK (shoutbox_order IN ('oldest-first', 'newest-first'));