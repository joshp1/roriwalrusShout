ALTER TABLE forum_subforums DROP CONSTRAINT forum_subforums_policy_check;
ALTER TABLE forum_subforums ADD CONSTRAINT forum_subforums_policy_check CHECK (
  (key IN ('public', 'art-3d', 'art-2d', 'ai-art', 'stories') AND required_permission IS NULL)
  OR (key = 'moderation' AND required_permission = 'posts.moderate')
);

INSERT INTO forum_subforums (key, label, required_permission)
VALUES ('ai-art', 'AI Art', NULL);
