import assert from 'node:assert/strict';
import test from 'node:test';
import { createForumRepository } from '../forum-database.js';

test('gallery repository returns linked artwork and applies liked ordering', async () => {
  const calls = [];
  const pool = {
    async query(sql, arguments_) {
      calls.push({ arguments_, sql });
      return { rows: [{
        artist_reputation: 8,
        author_account_id: 'artist-id',
        avatar_updated_at: null,
        byte_size: 1024,
        content_type: 'image/webp',
        created_at: '2026-09-23T12:00:00.000Z',
        display_name: 'Artist',
        file_name: 'art.webp',
        id: 7,
        like_count: 3,
        post_id: 5,
        post_offset: 50,
        subforum_key: 'art-2d',
        topic_id: 4,
        topic_title: 'Artwork topic',
        username: 'artist',
        username_color: 'default',
        username_color_effect: 'none',
        viewer_id: 'viewer-id',
        viewer_liked: true,
      }] };
    },
  };
  const result = await createForumRepository(pool).listGallery('viewer-id', 'liked', 25, 0);
  assert.match(calls[0].sql, /ORDER BY COALESCE\(visible_likes\.like_count, 0\) DESC/);
  assert.deepEqual(calls[0].arguments_, ['viewer-id', 25, 0, null, null, null]);
  assert.equal(result[0].forumUrl, '/?post=5&subforum=art-2d&topic=4&offset=50');
  assert.equal(result[0].likeCount, 3);
  assert.equal(result[0].artistReputation, 8);
  assert.equal(result[0].thumbnailUrl, '/api/attachments/7/thumbnail');
  assert.equal(result[0].viewerLiked, true);
  assert.equal(result[0].canLike, true);
});

test('gallery filters are parameterized and tag writes are limited to visible, owned art', async () => {
  const calls = [];
  const repository = createForumRepository({ query: async (sql, args) => {
    calls.push({ sql, args });
    return { rows: [] };
  } });
  await repository.listGallery('viewer', 'newest', 25, 24, { section: 'art-2d', tag: "artist's work", artist: 'someone' });
  assert.deepEqual(calls[0].args, ['viewer', 25, 24, 'art-2d', "artist's work", 'someone']);
  assert.match(calls[0].sql, /\$5 = ANY\(post_attachments.tags\)/);
  assert.match(calls[0].sql, /account_visible_to\(\$1, page_posts.author_account_id\)/);
  assert.doesNotMatch(calls[0].sql, /page_posts.deleted_at IS NULL/);
  assert.equal(await repository.setArtworkTags('viewer', '12', ['tag']), null);
  assert.match(calls[1].sql, /posts.author_account_id = \$1/);
  assert.match(calls[1].sql, /forum_topic_visible_to\(\$1, topics.id\)/);
  assert.match(calls[1].sql, /posts.deleted_at IS NULL AND topics.deleted_at IS NULL/);
  await repository.listGalleryTags('viewer', 'art-3d');
  assert.deepEqual(calls[2].args, ['viewer', 'art-3d']);
  assert.match(calls[2].sql, /account_visible_to\(\$1, posts.author_account_id\)/);
});

test('staff tag updates allow the server-derived override while retaining visibility restrictions', async () => {
  const calls = [];
  const repository = createForumRepository({ query: async (sql, args) => {
    calls.push({ sql, args });
    return { rows: [{ tags: ['landscape'] }] };
  } });
  await repository.setArtworkTags('moderator', '12', ['landscape'], true);
  assert.deepEqual(calls[0].args, ['moderator', '12', ['landscape'], true]);
  assert.match(calls[0].sql, /\(posts.author_account_id = \$1 OR \$4::boolean\)/);
  assert.match(calls[0].sql, /account_visible_to\(\$1, posts.author_account_id\)/);
  assert.match(calls[0].sql, /forum_topic_visible_to\(\$1, topics.id\)/);
  await repository.setArtworkTags('member', '12', ['landscape']);
  assert.equal(calls[1].args[3], false);
});

test('tag counts cover distinct visible artwork in the category and rank before limiting', async () => {
  let query;
  const repository = createForumRepository({ query: async (sql, args) => {
    query = { sql, args };
    return { rows: [{ tag: 'landscape', usage_count: '8' }, { tag: 'portrait', usage_count: '3' }] };
  } });
  assert.deepEqual(await repository.listGalleryTags('viewer', 'art-2d'), [
    { tag: 'landscape', count: 8 }, { tag: 'portrait', count: 3 },
  ]);
  assert.deepEqual(query.args, ['viewer', 'art-2d']);
  assert.match(query.sql, /count\(DISTINCT post_attachments.id\) AS usage_count/);
  assert.match(query.sql, /GROUP BY tag\s+ORDER BY usage_count DESC, tag ASC LIMIT 200/);
  assert.match(query.sql, /posts.deleted_at IS NULL AND topics.deleted_at IS NULL/);
  assert.match(query.sql, /account_visible_to\(\$1, posts.author_account_id\)/);
});
