ALTER TABLE accounts
  ADD COLUMN forum_posting_muted boolean NOT NULL DEFAULT false,
  ADD COLUMN shoutbox_posting_muted boolean NOT NULL DEFAULT false;