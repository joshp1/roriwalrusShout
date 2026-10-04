CREATE TABLE attachment_thumbnails (
  attachment_id bigint PRIMARY KEY REFERENCES post_attachments(id) ON DELETE CASCADE,
  content_type varchar(100) NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
