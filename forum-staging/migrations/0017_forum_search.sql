CREATE INDEX topics_search_idx
  ON topics USING gin (to_tsvector('simple', title))
  WHERE deleted_at IS NULL;

CREATE INDEX posts_search_idx
  ON posts USING gin (to_tsvector('simple', body))
  WHERE deleted_at IS NULL;