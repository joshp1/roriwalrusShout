import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createProfileService } from '../profile.js';
import { createRepository } from '../database.js';

const viewerId = '00000000-0000-4000-8000-000000000001';
test('directory includes a first page without a search and normalizes partial searches', async () => {
  const calls = [];
  const service = createProfileService({
    authService: { getSession: async () => ({ account: { id: viewerId } }) },
    repository: { listMembers: async (...args) => { calls.push(args); return [{ username: 'Self' }, { username: 'Other' }]; } },
  });
  assert.deepEqual(await service.listMembers('session', { limit: '1' }), {
    members: [{ username: 'Self' }], hasMore: true, nextOffset: 1,
  });
  assert.deepEqual(calls[0], [viewerId, '', 2, 0]);
  await service.listMembers('session', { q: '  THE  ', limit: '50', offset: '50' });
  assert.deepEqual(calls[1], [viewerId, 'the', 51, 50]);
  for (const query of [{ q: 'a'.repeat(33) }, { q: {} }, { limit: '0' }, { limit: '51' }, { offset: '-1' }]) {
    await assert.rejects(service.listMembers('session', query));
  }
});

test('directory requires a session', async () => {
  const service = createProfileService({
    authService: { getSession: async () => { throw new Error('unauthenticated'); } },
    repository: { listMembers: async () => assert.fail('must not query') },
  });
  await assert.rejects(service.listMembers(null), /unauthenticated/);
});

test('directory SQL includes self and offline accounts while preserving account visibility', async () => {
  let captured;
  const repo = createRepository({ query: async (sql, args) => {
    captured = { sql, args };
    return { rows: [{ username: 'Self' }] };
  } }, { dummyPasswordHash: 'unused' });
  assert.deepEqual(await repo.listMembers(viewerId, 'a_%', 51, 0), [{ username: 'Self' }]);
  assert.deepEqual(captured.args, [viewerId, '%a\\_\\%%', 51, 0]);
  assert.match(captured.sql, /account_visible_to\(\$1, id\)/);
  assert.match(captured.sql, /membership_status = 'active'/);
  assert.match(captured.sql, /deleted_at IS NULL/);
  assert.doesNotMatch(captured.sql, /id <>|JOIN sessions|status_and_activity_visible/);
});

test('members UI loads all members, searches, paginates, clears, and ignores old responses', async () => {
  const html = await readFile(new URL('../web/members.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../web/members.js', import.meta.url), 'utf8');
  function node() {
    return {
      children: [], hidden: false, disabled: false, value: '',
      addEventListener() {},
      replaceChildren(...items) { this.children = items; },
      append(...items) { this.children.push(...items); },
      get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text ?? ''; },
      set textContent(value) { this.text = value; this.children = []; },
    };
  }
  const nodes = new Map();
  const document = {
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    createElement: node, addEventListener() {}, visibilityState: 'visible',
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, URLSearchParams,
    location: { search: '', pathname: '/members', assign() {} },
    history: { replaceState() {} },
  });
  const calls = [];
  let delayed;
  Object.assign(context, {
    loadSession: async () => ({}), awaitPresence: async () => {},
    createStochasticRefreshScheduler: () => ({ start() {}, reschedule() {} }),
    request: async (url) => {
      calls.push(url);
      if (url === '/api/members/active') return { members: [{ username: 'Online' }] };
      const params = new URL(url, 'https://example.com').searchParams;
      if (params.get('q') === 'old') return new Promise((resolve) => { delayed = resolve; });
      return { members: [{ username: params.get('q') || 'Self' }], hasMore: params.get('offset') === '0', nextOffset: Number(params.get('offset')) + 1 };
    },
  });
  {
    vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/init\(\);\s*$/, ''), context);
    await vm.runInContext('init()', context);
    assert.equal(document.querySelector('#member-results').textContent, 'Self');
    assert.equal(document.querySelector('#active-members').textContent, 'Online');
    await vm.runInContext('searchMembers("part")', context);
    await vm.runInContext('searchMembers(currentQuery, true)', context);
    assert.match(calls.at(-1), /q=part&limit=50&offset=1/);
    assert.equal(document.querySelector('#member-results').textContent, 'partpart');
    const old = vm.runInContext('searchMembers("old")', context);
    await vm.runInContext('searchMembers("new")', context);
    delayed({ members: [{ username: 'Old' }], nextOffset: 1, hasMore: false });
    await old;
    assert.equal(document.querySelector('#member-results').textContent, 'new');
    await vm.runInContext('searchMembers("")', context);
    assert.equal(document.querySelector('#member-results').textContent, 'Self');
    assert.doesNotMatch(html.match(/<input id="member-prefix"[^>]*>/)[0], /required/);
  }
});
