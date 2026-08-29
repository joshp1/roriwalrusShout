ALTER TABLE accounts
  ADD COLUMN signature varchar(3000) NOT NULL DEFAULT '',
  ADD CONSTRAINT accounts_signature_lines_check CHECK (
    signature !~ E'\\r'
    AND length(signature) - length(replace(signature, E'\\n', '')) <= 2
  );