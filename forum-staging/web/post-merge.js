import { request } from './client.js';

const selected = new Map();
let topicId;
let toolbar;
let mergeButton;
let busy = false;

export function addMergeSelection(actions, post, { reload, status }) {
  if (topicId !== post.topicId) {
    selected.clear();
    topicId = post.topicId;
  }
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.className = 'post-merge-controls';
    mergeButton = document.createElement('button');
    mergeButton.type = 'button';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear selection';
    clear.addEventListener('click', () => {
      selected.clear();
      document.querySelectorAll('[data-merge-post]').forEach((input) => { input.checked = false; });
      update();
    });
    toolbar.append(mergeButton, clear);
    document.querySelector('#post-list').before(toolbar);
  }
  function update() {
    toolbar.hidden = selected.size === 0;
    mergeButton.textContent = `Merge selected posts (${selected.size})`;
    mergeButton.disabled = busy || selected.size < 2;
  }
  mergeButton.onclick = async () => {
    if (busy || selected.size < 2) return;
    const reason = window.prompt('Merge these posts into the earliest selected post, keeping their text in order and attachments. Reason for merging:');
    if (reason === null) return;
    if (reason.trim().length < 3 || reason.trim().length > 200) {
      status('Enter a merge reason between 3 and 200 characters.', true);
      return;
    }
    busy = true;
    update();
    try {
      const { post: merged } = await request(`/api/topics/${topicId}/posts/merge`, {
        method: 'POST', useCsrf: true,
        body: { posts: [...selected.values()].map(({ id, updatedAt }) => ({ id, updatedAt })), reason },
      });
      selected.clear();
      await reload(merged);
      status('Posts merged.');
    } catch (error) {
      const messages = {
        post_merge_conflict: 'A selected post changed. Reload and select the posts again.',
        post_merge_not_found: 'A selected post is no longer available. Reload and select again.',
        post_merge_different_authors: 'Select posts from the same author.',
        post_merge_too_long: 'The combined text exceeds the 10,000-character post limit. Select fewer posts.',
      };
      status(messages[error.code] ?? 'Could not merge posts.', true);
    } finally {
      busy = false;
      update();
    }
  };
  if (!post.deleted) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.mergePost = post.id;
    input.checked = selected.has(post.id);
    input.addEventListener('change', () => {
      if (input.checked) {
        if (selected.size >= 50 || [...selected.values()].some((item) => item.authorId !== post.authorId)) {
          input.checked = false;
          status('Select up to 50 posts from the same author.', true);
          return;
        }
        selected.set(post.id, post);
      } else selected.delete(post.id);
      update();
    });
    label.append(input, document.createTextNode(' Select to merge'));
    actions.append(label);
  }
  update();
}
