CREATE TABLE web_push_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  expiration_time_ms bigint,
  p256dh text NOT NULL,
  auth text NOT NULL,
  failure_count integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (endpoint ~ '^https://' AND char_length(endpoint) BETWEEN 1 AND 2048),
  CHECK (expiration_time_ms IS NULL OR expiration_time_ms > 0),
  CHECK (char_length(p256dh) BETWEEN 80 AND 120),
  CHECK (char_length(auth) BETWEEN 20 AND 40),
  CHECK (failure_count >= 0)
);

CREATE INDEX web_push_subscriptions_account_idx
  ON web_push_subscriptions (account_id, id);

CREATE TABLE web_push_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id bigint NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
  attempts smallint NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  discarded_at timestamptz,
  last_status smallint,
  last_error varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, subscription_id),
  CHECK (attempts BETWEEN 0 AND 8),
  CHECK (last_status IS NULL OR last_status BETWEEN 100 AND 599),
  CHECK (delivered_at IS NULL OR discarded_at IS NULL)
);

CREATE INDEX web_push_deliveries_pending_idx
  ON web_push_deliveries (available_at, id)
  WHERE delivered_at IS NULL AND discarded_at IS NULL;

CREATE FUNCTION enqueue_web_push_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO web_push_deliveries (notification_id, subscription_id)
  SELECT NEW.id, subscriptions.id
  FROM web_push_subscriptions subscriptions
  WHERE subscriptions.account_id = NEW.account_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_enqueue_web_push
AFTER INSERT ON notifications
FOR EACH ROW EXECUTE FUNCTION enqueue_web_push_delivery();