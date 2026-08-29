CREATE TABLE topic_subscriptions (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  topic_id bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, topic_id)
);

CREATE INDEX topic_subscriptions_topic_idx
  ON topic_subscriptions (topic_id, account_id);