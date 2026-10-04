CREATE TABLE attachment_likes (
  attachment_id bigint NOT NULL REFERENCES post_attachments(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attachment_id, account_id)
);

CREATE INDEX attachment_likes_account_id_idx
  ON attachment_likes(account_id, created_at DESC);
