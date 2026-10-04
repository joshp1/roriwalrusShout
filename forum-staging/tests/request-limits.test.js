import assert from 'node:assert/strict';
import test from 'node:test';
import { getAuthenticatedRateLimitSubject } from '../request-limits.js';

test('authenticated rate limits separate sessions behind one address', () => {
  const first = getAuthenticatedRateLimitSubject('127.0.0.1', 'first-session-token');
  const second = getAuthenticatedRateLimitSubject('127.0.0.1', 'second-session-token');

  assert.match(first, /^session:[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes('first-session-token'), false);
});

test('authenticated rate limits fall back to the network address', () => {
  assert.equal(
    getAuthenticatedRateLimitSubject('203.0.113.8', ''),
    'address:203.0.113.8',
  );
});
