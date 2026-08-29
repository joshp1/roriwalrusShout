CREATE TABLE topics (
  id bigserial PRIMARY KEY,
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  title varchar(120) NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX topics_activity_idx ON topics(updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE posts (
  id bigserial PRIMARY KEY,
  topic_id bigint NOT NULL REFERENCES topics(id),
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  body varchar(10000) NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posts_topic_created_idx ON posts(topic_id, created_at, id);
CREATE INDEX posts_author_created_idx ON posts(author_account_id, created_at DESC, id DESC);

CREATE TABLE post_revisions (
  id bigserial PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES posts(id),
  editor_account_id uuid NOT NULL REFERENCES accounts(id),
  body varchar(10000) NOT NULL,
  reason varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX post_revisions_post_created_idx
  ON post_revisions(post_id, created_at DESC, id DESC);