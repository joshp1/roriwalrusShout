import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageForumPost } from '../forum-database.js';

const post = {
  author_account_id: 'author',
  topic_author_account_id: 'topic-owner',
  topic_deleted_at: null,
  topic_locked: false,
};

test('authors can manage their own forum posts without a time limit', () => {
  assert.equal(canManageForumPost({
    ...post,
    created_at: new Date('2000-01-01T00:00:00Z'),
    topic_locked: true,
  }, 'author'), true);
});

test('members cannot manage posts written by someone else', () => {
  assert.equal(canManageForumPost(post, 'other-member'), false);
});

test('topic owners retain unlocked-topic controls and moderators retain controls', () => {
  assert.equal(canManageForumPost(post, 'topic-owner'), true);
  assert.equal(canManageForumPost({ ...post, topic_locked: true }, 'topic-owner'), false);
  assert.equal(canManageForumPost(post, 'moderator', true), true);
});

test('posts in deleted topics cannot be changed', () => {
  assert.equal(canManageForumPost({ ...post, topic_deleted_at: new Date() }, 'author'), false);
});
