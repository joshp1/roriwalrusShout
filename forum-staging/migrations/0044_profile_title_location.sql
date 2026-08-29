ALTER TABLE accounts
  ADD COLUMN title varchar(64) NOT NULL DEFAULT '',
  ADD COLUMN location varchar(80) NOT NULL DEFAULT '';