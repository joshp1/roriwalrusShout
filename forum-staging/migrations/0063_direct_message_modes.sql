ALTER TABLE direct_messages
  ADD COLUMN message_mode varchar(4) NOT NULL DEFAULT 'post',
  ADD CONSTRAINT direct_messages_mode_check CHECK (
    message_mode IN ('post', 'chat')
  );

CREATE INDEX direct_messages_thread_mode_id_idx
  ON direct_messages (thread_id, message_mode, id);

ALTER TABLE direct_message_members
  ADD COLUMN last_read_post_message_id bigint NOT NULL DEFAULT 0
    CHECK (last_read_post_message_id >= 0),
  ADD COLUMN last_read_chat_message_id bigint NOT NULL DEFAULT 0
    CHECK (last_read_chat_message_id >= 0);

UPDATE direct_message_members
SET last_read_post_message_id = last_read_message_id,
    last_read_chat_message_id = last_read_message_id;