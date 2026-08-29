ALTER TABLE accounts
  ADD COLUMN visible_to_role varchar(20);

ALTER TABLE accounts
  ADD CONSTRAINT accounts_visible_to_role_check
  CHECK (
    visible_to_role IS NULL
    OR (visible_to_role = 'dev' AND role = 'dev')
  );

CREATE OR REPLACE FUNCTION account_visible_to(viewer_account_id uuid, subject_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM accounts subjects
    LEFT JOIN accounts viewers ON viewers.id = viewer_account_id
    WHERE subjects.id = subject_account_id
      AND (
        subjects.visible_to_role IS NULL
        OR viewers.role = subjects.visible_to_role
      )
  )
$$;