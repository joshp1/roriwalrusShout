ALTER TABLE accounts
  ADD COLUMN time_zone varchar(100) NOT NULL DEFAULT 'local'
    CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9._+-]*(/[A-Za-z0-9._+-]+)*$');