ALTER TABLE site_settings
  ADD COLUMN access_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN access_block_reason varchar(500),
  ADD CONSTRAINT site_settings_access_block_check CHECK (
    (NOT access_blocked AND access_block_reason IS NULL)
    OR (
      access_blocked
      AND access_block_reason IS NOT NULL
      AND char_length(access_block_reason) BETWEEN 3 AND 500
      AND access_block_reason = btrim(access_block_reason)
    )
  );