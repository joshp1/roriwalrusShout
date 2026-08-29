ALTER TABLE direct_message_members
  ADD COLUMN visible_after_message_id bigint
  CHECK (visible_after_message_id >= 0);

ALTER TABLE direct_messages
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE INDEX direct_messages_thread_id_idx
  ON direct_messages(thread_id, id);