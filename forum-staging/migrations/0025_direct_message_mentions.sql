CREATE TABLE direct_message_mentions (
  message_id bigint NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  mentioned_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, mentioned_account_id)
);

CREATE INDEX direct_message_mentions_account_idx
  ON direct_message_mentions (mentioned_account_id, message_id DESC);