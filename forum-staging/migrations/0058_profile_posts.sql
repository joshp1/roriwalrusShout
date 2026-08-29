ALTER TABLE accounts
  ADD COLUMN profile_visitor_area_visible boolean NOT NULL DEFAULT true;

CREATE TABLE profile_posts (
  id bigserial PRIMARY KEY,
  profile_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, profile_account_id)
);

CREATE INDEX profile_posts_profile_active_created_idx
  ON profile_posts (profile_account_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE profile_post_revisions (
  id bigserial PRIMARY KEY,
  profile_post_id bigint NOT NULL REFERENCES profile_posts(id) ON DELETE CASCADE,
  editor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  reason varchar(500) NOT NULL CHECK (
    char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profile_post_revisions_post_created_idx
  ON profile_post_revisions (profile_post_id, created_at DESC, id DESC);

CREATE TABLE profile_post_comments (
  id bigserial PRIMARY KEY,
  profile_post_id bigint NOT NULL,
  profile_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (profile_post_id, profile_account_id)
    REFERENCES profile_posts(id, profile_account_id) ON DELETE CASCADE
);

CREATE INDEX profile_post_comments_post_active_created_idx
  ON profile_post_comments (profile_post_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE TABLE profile_post_comment_revisions (
  id bigserial PRIMARY KEY,
  profile_post_comment_id bigint NOT NULL
    REFERENCES profile_post_comments(id) ON DELETE CASCADE,
  editor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  reason varchar(500) NOT NULL CHECK (
    char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profile_post_comment_revisions_comment_created_idx
  ON profile_post_comment_revisions (profile_post_comment_id, created_at DESC, id DESC);

CREATE TABLE profile_visitor_posts (
  id bigserial PRIMARY KEY,
  profile_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX profile_visitor_posts_profile_active_created_idx
  ON profile_visitor_posts (profile_account_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE profile_visitor_post_revisions (
  id bigserial PRIMARY KEY,
  profile_visitor_post_id bigint NOT NULL
    REFERENCES profile_visitor_posts(id) ON DELETE CASCADE,
  editor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  body varchar(10000) NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)
  ),
  reason varchar(500) NOT NULL CHECK (
    char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profile_visitor_post_revisions_post_created_idx
  ON profile_visitor_post_revisions (profile_visitor_post_id, created_at DESC, id DESC);