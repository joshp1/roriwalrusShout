CREATE INDEX accounts_active_mention_prefix_idx
  ON accounts (normalized_username COLLATE "C" text_pattern_ops)
  WHERE membership_status = 'active' AND deleted_at IS NULL;