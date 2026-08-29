CREATE INDEX moderation_audit_restart_created_idx
  ON moderation_audit_events (created_at DESC)
  WHERE action = 'server.restart.requested';