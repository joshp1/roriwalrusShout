ALTER TABLE profile_visitor_posts
  ADD CONSTRAINT profile_visitor_posts_id_profile_account_unique
  UNIQUE (id, profile_account_id);

CREATE TABLE profile_visitor_post_comments (
  id bigserial PRIMARY KEY,
  profile_visitor_post_id bigint NOT NULL,
  profile_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (profile_visitor_post_id, profile_account_id)
    REFERENCES profile_visitor_posts(id, profile_account_id) ON DELETE CASCADE
);

CREATE INDEX profile_visitor_post_comments_post_active_created_idx
  ON profile_visitor_post_comments (profile_visitor_post_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE TABLE profile_visitor_post_comment_revisions (
  id bigserial PRIMARY KEY,
  profile_visitor_post_comment_id bigint NOT NULL
    REFERENCES profile_visitor_post_comments(id) ON DELETE CASCADE,
  editor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  reason varchar(500) NOT NULL CHECK (
    char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profile_visitor_post_comment_revisions_comment_created_idx
  ON profile_visitor_post_comment_revisions (
    profile_visitor_post_comment_id, created_at DESC, id DESC
  );