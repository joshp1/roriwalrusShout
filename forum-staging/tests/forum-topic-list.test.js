import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('topic list renders actual rows and both reply destinations', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function bo(');
  const end = source.indexOf('async function yo', start);
  assert.ok(start >= 0 && end > start);
  const navigations = [];
  const context = vm.createContext({
    document: {
      createElement(tagName) {
        return {
          tagName, children: [], events: {}, attributes: {},
          append(...children) { this.children.push(...children); },
          addEventListener(type, callback) { this.events[type] = callback; },
          setAttribute(name, value) { this.attributes[name] = value; },
        };
      },
    },
    window: { RWShell: { navigate: href => navigations.push(href) } },
    Vt: topic => `/?topic=${topic.id}`,
  });
  vm.runInContext(source.slice(start, end), context);
  const rows = vm.runInContext(`[
    { id: '12', title: 'An artwork', author: 'Artist', postCount: 53 },
    { id: '13', title: 'A discussion', author: 'Member', postCount: 2 },
  ].map(bo)`, context);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row, 'the renderer must return a DOM row, not undefined');
    assert.equal(row.tagName, 'div');
    assert.equal(row.children.length, 2);
  }
  const [topic, unread] = rows[0].children;
  assert.equal(topic.children[0].textContent, 'An artwork');
  assert.equal(topic.children[1].textContent, 'Artist · 53 posts');
  assert.equal(unread.textContent, 'First unread');
  topic.events.click();
  unread.events.click();
  assert.deepEqual(navigations, ['/?topic=12&jump=newest', '/?topic=12&jump=unread']);
});
