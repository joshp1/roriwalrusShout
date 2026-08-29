CREATE TABLE post_mentions (
  post_id bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  mentioned_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, mentioned_account_id)
);

CREATE INDEX post_mentions_account_idx
  ON post_mentions (mentioned_account_id, post_id DESC);

CREATE TABLE shout_mentions (
  shout_id bigint NOT NULL REFERENCES shouts(id) ON DELETE CASCADE,
  mentioned_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (shout_id, mentioned_account_id)
);

CREATE INDEX shout_mentions_account_idx
  ON shout_mentions (mentioned_account_id, shout_id DESC);