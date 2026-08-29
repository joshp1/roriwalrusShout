ALTER TABLE accounts DROP CONSTRAINT accounts_font_size_check;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_font_size_check
  CHECK (font_size IN ('compact', 'standard', 'comfortable', 'large', 'extra-large'));