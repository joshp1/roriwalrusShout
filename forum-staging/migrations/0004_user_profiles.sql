ALTER TABLE accounts
  ADD COLUMN description varchar(500) NOT NULL DEFAULT '',
  ADD COLUMN username_color varchar(16) NOT NULL DEFAULT 'default';

ALTER TABLE accounts
  ADD CONSTRAINT accounts_username_color_check
  CHECK (username_color IN ('default', 'forest', 'red', 'blue', 'gold', 'teal'));

CREATE TABLE account_follows (
  follower_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  followed_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_account_id, followed_account_id),
  CHECK (follower_account_id <> followed_account_id)
);

CREATE INDEX account_follows_followed_idx
  ON account_follows(followed_account_id, created_at DESC);

CREATE INDEX topics_author_created_idx
  ON topics(author_account_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;