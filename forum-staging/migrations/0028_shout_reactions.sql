CREATE TABLE shout_reactions (
  shout_id bigint NOT NULL REFERENCES shouts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN (
    '😀', '😂', '😊', '😉', '😍', '😎', '🤔', '😮', '😢',
    '😡', '👍', '👎', '👏', '🙏', '❤️', '🎉', '🔥', '✅'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shout_id, account_id)
);

CREATE INDEX shout_reactions_shout_idx
  ON shout_reactions(shout_id, reaction, created_at, account_id);