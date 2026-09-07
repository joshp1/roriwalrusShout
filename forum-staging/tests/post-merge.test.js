import assert from 'node:assert/strict';
import test from 'node:test';
import { createForumService } from '../forum.js';
import { createForumRepository } from '../forum-database.js';

const updatedAt = '2026-09-07T12:00:00.000Z';
const posts = [{ id: '1', updatedAt }, { id: '2', updatedAt }];
const input = { posts, reason: 'Double posting' };
function service(account, repository, csrf = async () => {}) {
  return createForumService({ authService: {
    getSession: async () => ({ account }), requireCsrf: csrf,
  }, repository });
}
test('only administrators and moderators with post moderation may merge', async () => {
  for (const account of [
    { role: 'member', permissions: ['posts.moderate'] },
    { role: 'moderator', permissions: [] },
  ]) {
    await assert.rejects(service(account, {}).mergePosts('s', 'c', '1', input), { code: 'permission_denied' });
  }
  for (const account of [{ role: 'admin' }, { role: 'moderator', permissions: ['posts.moderate'] }]) {
    assert.equal(await service(account, { mergePosts: async () => ({ status: 'ok', post: 'merged' }) })
      .mergePosts('s', 'c', '1', input), 'merged');
  }
});
test('CSRF and invalid selections stop before mutation', async () => {
  const api = service({ role: 'admin' }, { mergePosts: () => assert.fail('unexpected mutation') });
  for (const bad of [null, {}, { ...input, posts: [posts[0]] }, { ...input, posts: [posts[0], posts[0]] },
    { ...input, posts: [posts[0], { id: '2' }] }, { ...input, reason: '' }]) {
    await assert.rejects(api.mergePosts('s', 'c', '1', bad));
  }
  await assert.rejects(service({ role: 'admin' }, {}, async () => { throw new Error('csrf'); })
    .mergePosts('s', 'c', '1', input), /csrf/);
});
function repository(rows, fail = false) {
  const calls = [];
  const client = { release() {}, async query(sql, args) {
    calls.push({ sql, args });
    if (sql.includes('SELECT posts.* FROM posts JOIN')) return { rows };
    if (fail && sql.startsWith('UPDATE post_attachments')) throw new Error('attachment failure');
    if (sql.includes('SELECT posts.*, topics.title')) return { rows: [{ ...rows[0], body: 'first\n\nsecond' }] };
    return { rows: [] };
  } };
  return { calls, repo: createForumRepository({ connect: async () => client }) };
}
const rows = [1, 2].map((id) => ({ id: String(id), topic_id: '9', author_account_id: 'author',
  body: id === 1 ? 'first' : 'second', updated_at: updatedAt }));
const args = { actorId: 'mod', topicId: '9', posts, reason: input.reason, updatedAt: new Date() };
test('merge keeps earliest post, revisions, attachments, mentions, reactions and audit in one transaction', async () => {
  const { repo, calls } = repository(rows);
  const result = await repo.mergePosts(args);
  assert.equal(result.status, 'ok');
  assert.equal(result.post.body, 'first\n\nsecond');
  assert.match(calls[1].sql, /ORDER BY posts.created_at, posts.id FOR UPDATE/);
  assert.deepEqual(calls.find(({ sql }) => sql.startsWith('UPDATE posts SET body')).args.slice(0, 2), ['1', 'first\n\nsecond']);
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO post_revisions')).length, 2);
  for (const table of ['post_attachments', 'post_mentions', 'post_reactions', 'moderation_audit_events']) {
    assert.ok(calls.some(({ sql }) => sql.includes(table)));
  }
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
test('stale, missing, different-author and oversized selections cannot change posts', async () => {
  for (const [selectedRows, status] of [
    [rows.slice(0, 1), 'not_found'],
    [[rows[0], { ...rows[1], author_account_id: 'other' }], 'different_authors'],
    [[rows[0], { ...rows[1], updated_at: '2026-09-07T13:00:00Z' }], 'conflict'],
    [[rows[0], { ...rows[1], body: 'x'.repeat(10000) }], 'too_long'],
  ]) {
    const { repo, calls } = repository(selectedRows);
    assert.equal((await repo.mergePosts(args)).status, status);
    assert.equal(calls.length, 3);
  }
});
test('attachment failures roll back all merge changes', async () => {
  const { repo, calls } = repository(rows, true);
  await assert.rejects(repo.mergePosts(args), /attachment failure/);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('selection UI enforces authors, submits versions and clears after merging', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: vm } = await import('node:vm');
  const nodes = [];
  function node() {
    const item = { children: [], dataset: {}, listeners: {},
      append(...children) { this.children.push(...children); },
      before(child) { this.toolbar = child; },
      addEventListener(event, fn) { this.listeners[event] = fn; },
    };
    nodes.push(item);
    return item;
  }
  const list = node();
  const calls = [];
  const messages = [];
  const source = (await readFile(new URL('../web/post-merge.js', import.meta.url), 'utf8'))
    .replace(/^import .*\n/, '').replace('export function', 'function');
  const context = vm.createContext({
    document: { createElement: node, createTextNode: (text) => text,
      querySelector: () => list, querySelectorAll: () => nodes.filter((item) => item.dataset.mergePost) },
    window: { prompt: () => 'Double posting' },
    request: async (url, options) => { calls.push({ url, options }); return { post: { id: '1' } }; },
  });
  vm.runInContext(source, context);
  const options = { status: (...args) => messages.push(args), reload: async () => {} };
  for (const [id, authorId] of [['1', 'a'], ['2', 'a'], ['3', 'b']]) {
    context.addMergeSelection(node(), { id, authorId, topicId: '9', updatedAt }, options);
  }
  const checks = nodes.filter((item) => item.dataset.mergePost);
  checks[0].checked = true;
  checks[0].listeners.change();
  const button = list.toolbar.children[0];
  assert.equal(button.disabled, true);
  checks[2].checked = true;
  checks[2].listeners.change();
  assert.equal(checks[2].checked, false);
  checks[1].checked = true;
  checks[1].listeners.change();
  assert.equal(button.disabled, false);
  await button.onclick();
  assert.equal(calls[0].url, '/api/topics/9/posts/merge');
  assert.equal(calls[0].options.useCsrf, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options.body.posts)), posts);
  assert.equal(list.toolbar.hidden, true);
  assert.equal(messages.at(-1)[0], 'Posts merged.');
});
