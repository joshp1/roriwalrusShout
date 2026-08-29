CREATE TABLE post_attachments (
  id bigserial PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  uploader_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_name varchar(180) NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  content_type varchar(32) NOT NULL CHECK (content_type IN (
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav',
    'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/webm'
  )),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  data bytea NOT NULL CHECK (octet_length(data) = byte_size),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX post_attachments_post_id_id_idx
  ON post_attachments (post_id, id);

CREATE INDEX post_attachments_uploader_account_id_idx
  ON post_attachments (uploader_account_id);