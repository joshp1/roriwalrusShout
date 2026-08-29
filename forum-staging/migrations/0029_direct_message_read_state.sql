ALTER TABLE direct_message_members
  ADD COLUMN last_read_message_id bigint NOT NULL DEFAULT 0
  CHECK (last_read_message_id >= 0);

UPDATE direct_message_members members
SET last_read_message_id = COALESCE((
  SELECT MAX(messages.id)
  FROM direct_messages messages
  WHERE messages.thread_id = members.thread_id
), 0);