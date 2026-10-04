ALTER TABLE post_attachments ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX post_attachments_tags_idx ON post_attachments USING gin(tags);
CREATE TABLE topic_reading (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  topic_id bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  post_created_at timestamptz NOT NULL,
  post_id bigint NOT NULL,
  PRIMARY KEY (account_id, topic_id)
);
