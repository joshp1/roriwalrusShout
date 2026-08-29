UPDATE accounts
SET membership_status = 'active', updated_at = now()
WHERE membership_status = 'pending'
  AND email_verified_at IS NOT NULL
  AND deleted_at IS NULL;