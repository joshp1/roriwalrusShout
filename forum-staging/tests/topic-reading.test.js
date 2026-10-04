import assert from 'node:assert/strict';
import test from 'node:test';
import { createForumService } from '../forum.js';
import { createForumRepository } from '../forum-database.js';
import { observeTopicReading } from '../web/topic-reading.js';

const authService = {
  getSession: async () => ({ account: { id: 'viewer' } }),
  requireCsrf: async () => {},
};

test('newest and first unread resolve the destination page and preserve explicit offset links', async () => {
  const calls = [];
  const api = createForumService({ authService, repository: {
    getTopicDestination: async (...args) => { calls.push(args); return { offset: 100, postId: '111' }; },
    getTopic: async (...args) => { calls.push(args); return { topic: { id: '1' }, posts: Array(12).fill({ id: '111' }) }; },
  } });
  for (const jump of ['newest', 'unread']) {
    const result = await api.getTopic('session', '1', { limit: '50', jump });
    assert.equal(result.targetPostId, '111');
    assert.equal(result.offset, 100);
    assert.equal(result.nextOffset, 112);
    assert.equal(result.hasMore, false);
    assert.deepEqual(calls.at(-2), ['viewer', '1', jump, 50]);
    assert.deepEqual(calls.at(-1), ['1', 'viewer', 51, 100]);
  }
  const result = await api.getTopic('session', '1', { limit: '50', offset: '50' });
  assert.equal(result.offset, 50);
  assert.equal(result.targetPostId, null);
  await assert.rejects(api.getTopic('session', '1', { jump: 'random' }), { code: 'invalid_forum_query' });
});

test('read positions require CSRF and valid post and topic IDs', async () => {
  const calls = [];
  const api = createForumService({ authService, repository: { markTopicRead: async (...args) => calls.push(args) } });
  await api.markTopicRead('session', 'csrf', '1', { postId: '22' });
  assert.deepEqual(calls, [['viewer', '1', '22']]);
  await assert.rejects(api.markTopicRead('session', 'csrf', '1', { postId: 'no' }), { code: 'invalid_post' });
  const denied = createForumService({ authService: { ...authService, requireCsrf: async () => { throw new Error('csrf'); } }, repository: {} });
  await assert.rejects(denied.markTopicRead('session', 'bad', '1', { postId: '22' }), /csrf/);
});

test('destination ranks the same visible posts as pagination, and read progress cannot move backward', async () => {
  const calls = [];
  const repository = createForumRepository({ query: async (sql, args) => {
    calls.push({ sql, args });
    return { rows: [{ id: '111', offset: '100' }], rowCount: 1 };
  } });
  assert.deepEqual(await repository.getTopicDestination('viewer', '1', 'unread', 50), { postId: '111', offset: 100 });
  assert.match(calls[0].sql, /row_number\(\) OVER \(ORDER BY posts.created_at, posts.id\)/);
  assert.match(calls[0].sql, /account_visible_to\(\$1, posts.author_account_id\)/);
  assert.match(calls[0].sql, /WHERE deleted_at IS NULL/);
  await repository.markTopicRead('viewer', '1', '111');
  assert.match(calls[1].sql, /posts.id = \$3 AND posts.topic_id = \$2/);
  assert.match(calls[1].sql, /WHERE \(topic_reading.post_created_at, topic_reading.post_id\) </);
});

test('only visible, nondeleted replies advance reading; leaving flushes and awaits the save', async t => {
  let callback;
  const observed = [];
  const previousObserver = globalThis.IntersectionObserver;
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  globalThis.IntersectionObserver = class {
    constructor(fn) { callback = fn; }
    observe(element) { observed.push(element); }
    unobserve() {}
    disconnect() {}
  };
  t.after(() => { globalThis.IntersectionObserver = previousObserver; globalThis.document = previousDocument; });
  const elements = ['1', '2', '3'].map(postId => ({ dataset: { postId } }));
  const calls = [];
  const stop = observeTopicReading({ querySelectorAll: () => elements }, '7', async (...args) => calls.push(args), [
    { id: '1' }, { id: '2', deleted: true }, { id: '3' },
  ]);
  assert.deepEqual(observed, [elements[0], elements[2]]);
  assert.equal(calls.length, 0);
  callback([{ target: elements[0], isIntersecting: true }, { target: elements[2], isIntersecting: false }]);
  await stop();
  assert.deepEqual(calls, [['/api/topics/7/read', { method: 'PUT', useCsrf: true, body: { postId: '1' } }]]);
  callback([{ target: elements[2], isIntersecting: true }]);
  await stop();
  assert.equal(calls.length, 1);
});
