CREATE TABLE post_reactions (
  post_id bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (
    char_length(reaction) BETWEEN 1 AND 16
    AND octet_length(reaction) <= 64
    AND reaction !~ '[[:cntrl:][:space:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, account_id)
);

CREATE INDEX post_reactions_post_idx
  ON post_reactions(post_id, reaction, created_at, account_id);