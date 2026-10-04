import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiRouteSchema } from '../api-schema.js';
import { createForumService } from '../forum.js';

function service(repository) {
  return createForumService({
    authService: {
      getSession: async () => ({ account: { id: 'viewer', role: 'member' } }),
      requireCsrf: async () => {},
    },
    repository,
  });
}

test('gallery uses a bounded page and supports newest and most-liked ordering', async () => {
  const calls = [];
  const api = service({
    listGalleryTags: async () => [],
    listGallery: async (...arguments_) => {
      calls.push(arguments_);
      return Array.from({ length: 3 }, (_, index) => ({ id: String(index + 1) }));
    },
  });
  const page = await api.listGallery('session', { limit: '2', offset: '4', sort: 'liked' });
  assert.deepEqual(calls[0], ['viewer', 'liked', 3, 4, {}]);
  assert.equal(page.artwork.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 6);
  await assert.rejects(
    api.listGallery('session', { sort: 'controversial' }),
    { code: 'invalid_gallery_sort' },
  );
});

test('artwork likes require CSRF and reject self-likes', async () => {
  const calls = [];
  const api = service({
    setArtworkLiked: async (...arguments_) => {
      calls.push(arguments_);
      return { status: 'self' };
    },
  });
  await assert.rejects(
    api.setArtworkLiked('session', 'csrf', '12', true),
    { code: 'cannot_like_own_artwork', statusCode: 403 },
  );
  assert.deepEqual(calls[0], ['viewer', '12', true]);
});

test('gallery and artwork-like API routes are registered', () => {
  assert.equal(getApiRouteSchema('GET', '/api/gallery')?.area, 'forum');
  assert.equal(getApiRouteSchema('GET', '/api/attachments/12/likes')?.area, 'forum');
  assert.equal(getApiRouteSchema('GET', '/api/attachments/12/thumbnail')?.area, 'forum');
  assert.equal(getApiRouteSchema('PUT', '/api/attachments/12/likes')?.area, 'forum');
  assert.equal(getApiRouteSchema('DELETE', '/api/attachments/12/likes')?.area, 'forum');
});

test('gallery forwards normalized filters before pagination and returns tag choices', async () => {
  let arguments_;
  const api = service({
    listGallery: async (...args) => { arguments_ = args; return []; },
    listGalleryTags: async (viewer, section) => {
      assert.equal(viewer, 'viewer');
      assert.equal(section, 'art-3d');
      return [{ tag: 'landscape', count: 8 }];
    },
  });
  const result = await api.listGallery('session', { section: 'art-3d', tag: ' Landscape ', artist: 'Painter', offset: '24' });
  assert.deepEqual(arguments_, ['viewer', 'newest', 25, 24, { section: 'art-3d', tag: 'landscape', artist: 'Painter' }]);
  assert.deepEqual(result.tags, ['landscape']);
  assert.deepEqual(result.tagUsage, [{ tag: 'landscape', count: 8 }]);
  await assert.rejects(api.listGallery('session', { section: 'moderation' }), { code: 'invalid_subforum' });
});

test('tag edits normalize, deduplicate, bound input, and reject unavailable artwork', async () => {
  let written;
  const api = service({ setArtworkTags: async (...args) => { written = args; return { tags: args[2] }; } });
  const result = await api.setArtworkTags('session', 'csrf', '12', { tags: [' Landscape ', 'LANDSCAPE', '3D   Art'] });
  assert.deepEqual(result.tags, ['landscape', '3d art']);
  assert.deepEqual(written, ['viewer', '12', ['landscape', '3d art'], false]);
  for (const tags of [Array(11).fill('a'), ['x'.repeat(41)], [''], [3], ['bad\u0000name'], ['a,b']]) {
    await assert.rejects(api.setArtworkTags('session', 'csrf', '12', { tags }), { code: 'invalid_tags' });
  }
  await assert.rejects(service({ setArtworkTags: async () => null }).setArtworkTags('session', 'csrf', '12', { tags: [] }), { code: 'artwork_not_found' });
  const denied = createForumService({ authService: { getSession: async () => ({ account: { id: 'viewer' } }), requireCsrf: async () => { throw new Error('csrf'); } }, repository: {} });
  await assert.rejects(denied.setArtworkTags('session', 'bad', '12', { tags: [] }), /csrf/);
});

test('gallery tag editing uses the same staff permission for controls and mutations', async () => {
  for (const [account, allowed] of [
    [{ role: 'admin' }, true],
    [{ role: 'owner' }, true],
    [{ role: 'dev' }, true],
    [{ role: 'moderator', permissions: ['posts.moderate'] }, true],
    [{ role: 'moderator', permissions: ['shouts.moderate'] }, false],
    [{ role: 'member', permissions: ['posts.moderate'] }, false],
  ]) {
    let receivedPermission;
    const api = createForumService({
      authService: {
        getSession: async () => ({ account: { id: 'viewer', ...account } }),
        requireCsrf: async () => {},
      },
      repository: {
        listGallery: async () => [{ id: '12', canEditTags: false }, { id: '13', canEditTags: true }],
        listGalleryTags: async () => [],
        setArtworkTags: async (_viewer, _id, tags, moderator) => {
          receivedPermission = moderator;
          return moderator ? { tags } : null;
        },
      },
    });
    const gallery = await api.listGallery('session');
    assert.equal(gallery.artwork[0].canEditTags, allowed);
    assert.equal(gallery.artwork[1].canEditTags, true);
    const mutation = api.setArtworkTags('session', 'csrf', '12', { tags: ['landscape'], moderator: true });
    if (allowed) assert.deepEqual(await mutation, { tags: ['landscape'] });
    else await assert.rejects(mutation, { code: 'artwork_not_found' });
    assert.equal(receivedPermission, allowed);
  }
});
