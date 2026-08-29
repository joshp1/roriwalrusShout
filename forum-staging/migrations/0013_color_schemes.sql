ALTER TABLE accounts
  ADD COLUMN color_scheme varchar(10) NOT NULL DEFAULT 'green';

ALTER TABLE accounts
  ADD CONSTRAINT accounts_color_scheme_check CHECK (
    color_scheme IN ('green', 'blue', 'tan', 'red', 'black', 'gray')
  );