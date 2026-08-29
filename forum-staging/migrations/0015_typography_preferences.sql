ALTER TABLE accounts
  ADD COLUMN font_size varchar(20) NOT NULL DEFAULT 'standard'
    CHECK (font_size IN ('compact', 'standard', 'comfortable', 'large')),
  ADD COLUMN font_typeface varchar(20) NOT NULL DEFAULT 'verdana'
    CHECK (font_typeface IN ('verdana', 'trebuchet', 'georgia', 'monospace'));