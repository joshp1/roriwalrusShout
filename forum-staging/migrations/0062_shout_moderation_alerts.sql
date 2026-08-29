DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounts WHERE normalized_username = 'staff'
  ) THEN
    RAISE EXCEPTION 'staff username conflicts with the reserved Shoutbox group mention';
  END IF;

  INSERT INTO username_reservations (normalized_username) VALUES ('staff');
END;
$$;

ALTER TABLE notifications
  ADD COLUMN required_permission varchar(40),
  ADD CONSTRAINT notifications_required_permission_check CHECK (
    required_permission IS NULL OR required_permission = 'shouts.moderate'
  );

CREATE TABLE shout_staff_mentions (
  shout_id bigint PRIMARY KEY REFERENCES shouts(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shout_staff_mentions_time_check CHECK (updated_at >= created_at)
);

CREATE TABLE shout_flags (
  id bigserial PRIMARY KEY,
  shout_id bigint NOT NULL REFERENCES shouts(id) ON DELETE CASCADE,
  reporter_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  reason varchar(500) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'open',
  decided_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_reason varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shout_flags_reporter_unique UNIQUE (shout_id, reporter_account_id),
  CONSTRAINT shout_flags_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 3 AND 500
  ),
  CONSTRAINT shout_flags_status_check CHECK (
    status IN ('open', 'resolved', 'dismissed')
  ),
  CONSTRAINT shout_flags_decision_check CHECK (
    (
      status = 'open'
      AND decided_by_account_id IS NULL
      AND decided_at IS NULL
      AND decision_reason IS NULL
    )
    OR (
      status IN ('resolved', 'dismissed')
      AND decided_at IS NOT NULL
      AND decision_reason IS NOT NULL
      AND char_length(btrim(decision_reason)) BETWEEN 3 AND 500
    )
  ),
  CONSTRAINT shout_flags_time_check CHECK (updated_at >= created_at)
);

CREATE INDEX shout_flags_open_shout_idx
  ON shout_flags (shout_id, created_at, id)
  WHERE status = 'open';

CREATE INDEX shout_flags_reporter_idx
  ON shout_flags (reporter_account_id, created_at DESC, id DESC)
  WHERE reporter_account_id IS NOT NULL;