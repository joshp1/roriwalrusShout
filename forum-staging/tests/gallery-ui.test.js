import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('gallery combines filters, paginates, ignores stale requests, and saves artwork tags', async () => {
  function node() {
    return {
      children: [], dataset: {}, events: {}, attributes: {}, value: '',
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      showModal() {}, close() {},
    };
  }
  const nodes = new Map();
  const document = {
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    querySelectorAll() { return []; }, createElement: node,
  };
  document.querySelector('#gallery-filters').elements = { tag: node(), artist: node() };
  const calls = [];
  let delayed;
  const context = vm.createContext({
    document, URLSearchParams, window: { addEventListener() {} },
    location: { search: '?section=art-2d&tag=landscape&artist=Painter', pathname: '/gallery' },
    history: { replaceState() {} },
    renderUsernameColor() {}, renderArtworkTags() {}, renderArtworkLikeButton() {},
    loadSession: async () => ({}), awaitPresence: async () => {},
    request: async (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'PUT') return { tags: options.body.tags };
      const parameters = new URL(url, 'https://example.com').searchParams;
      if (parameters.get('tag') === 'old') return new Promise(resolve => { delayed = resolve; });
      return { artwork: [{ id: '12', topicTitle: parameters.get('tag'), tags: [], canEditTags: true }], tags: ['landscape', 'portrait'], tagUsage: [{ tag: 'landscape', count: 8 }, { tag: 'portrait', count: 3 }], hasMore: true, nextOffset: 24 };
    },
  });
  const source = await readFile(new URL('../web/gallery.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/init\(\);\s*$/, ''), context);
  await vm.runInContext('init()', context);
  assert.deepEqual(document.querySelector('#gallery-tags').children.map(button => button.textContent), ['All tags', '#landscape (8)', '#portrait (3)']);
  assert.match(calls[0].url, /section=art-2d&tag=landscape&artist=Painter/);
  await vm.runInContext('loadGallery({append:true})', context);
  assert.match(calls.at(-1).url, /offset=24/);
  assert.equal(document.querySelector('#gallery-grid').children.length, 2);
  const old = vm.runInContext("currentTag='old';loadGallery()", context);
  await vm.runInContext("currentTag='new';loadGallery()", context);
  delayed({ artwork: [{ id: '99' }], tags: [], hasMore: false, nextOffset: 1 });
  await old;
  assert.equal(vm.runInContext('artwork[0].topicTitle', context), 'new');
  vm.runInContext('showArtwork(artwork[0])', context);
  const form = document.querySelector('#gallery-dialog-details').children.at(-1);
  const input = form.children[0].children[0];
  input.value = 'Landscape, 3D';
  await form.events.submit({ preventDefault() {} });
  const mutation = calls.find(call => call.options?.method === 'PUT');
  assert.equal(mutation.url, '/api/attachments/12/tags');
  assert.equal(mutation.options.useCsrf, true);
  assert.equal(JSON.stringify(mutation.options.body.tags), '["Landscape","3D"]');
});
