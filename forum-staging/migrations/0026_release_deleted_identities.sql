DELETE FROM email_verification_tokens tokens
USING accounts
WHERE accounts.deleted_at IS NOT NULL
  AND tokens.account_id = accounts.id;

DELETE FROM password_reset_tokens tokens
USING accounts
WHERE accounts.deleted_at IS NOT NULL
  AND tokens.account_id = accounts.id;

DELETE FROM username_reservations reservations
USING accounts
WHERE accounts.deleted_at IS NOT NULL
  AND reservations.normalized_username = accounts.normalized_username;

UPDATE accounts
SET email = 'deleted-' || id::text || '@deleted.invalid',
  normalized_email = 'deleted-' || id::text || '@deleted.invalid',
  username = 'Deleted account',
  display_name = 'Deleted account',
  normalized_username = 'deleted-' || left(replace(id::text, '-', ''), 24),
  email_verified_at = NULL
WHERE deleted_at IS NOT NULL;