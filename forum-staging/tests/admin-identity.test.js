import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdministrationService } from '../administration.js';
import { createRepository } from '../database.js';

const actorId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const version = new Date('2026-09-01T00:00:00Z');
const now = new Date('2026-09-05T00:00:00Z');

function serviceFixture(role = 'admin', result = { account: { id: targetId } }) {
  const writes = [];
  const service = createAdministrationService({
    clock: () => now,
    authService: {
      getSession: async () => ({ account: { id: actorId, role, permissions: ['users.view', 'users.moderate'] } }),
      requireCsrf: async (_, token) => { assert.equal(token, 'csrf'); },
    },
    repository: {
      findManagedAccount: async () => ({ id: targetId, role: 'member', membershipStatus: 'pending' }),
      manageAccount: async (mutation) => {
        writes.push(mutation);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  });
  return {
    writes,
    update: (fields) => service.updateAccount('session', 'csrf', targetId, {
      expectedUpdatedAt: version.toISOString(), ...fields,
    }),
  };
}

test('administrator corrections normalize identifiers and retain the account version', async () => {
  const fixture = serviceFixture();
  await fixture.update({ email: ' Correct@Example.com ', username: ' New User ' });
  assert.deepEqual(fixture.writes[0].updates, {
    email: 'correct@example.com', normalizedEmail: 'correct@example.com',
    username: 'New User', normalizedUsername: 'new user', displayName: 'New User',
  });
  assert.deepEqual(fixture.writes[0].expectedUpdatedAt, version);
  assert.equal(fixture.writes[0].actorId, actorId);
});

test('delegated moderators cannot change either identity field', async () => {
  const fixture = serviceFixture('moderator');
  for (const fields of [{ email: 'a@example.com' }, { username: 'someone' }]) {
    await assert.rejects(fixture.update(fields), { code: 'permission_denied' });
  }
  assert.equal(fixture.writes.length, 0);
});

test('invalid identity input is rejected before writing', async () => {
  const fixture = serviceFixture();
  for (const [fields, code] of [
    [{ email: 'broken' }, 'invalid_email'], [{ email: null }, 'invalid_email'],
    [{ username: 'ab' }, 'invalid_username'], [{ username: '<script>' }, 'invalid_username'],
    [{ username: 'three word name' }, 'invalid_username'],
  ]) await assert.rejects(fixture.update(fields), { code });
  assert.equal(fixture.writes.length, 0);
});

test('conflicts produce actionable API errors', async () => {
  for (const [result, code] of [
    [{ account: null }, 'account_update_conflict'],
    [{ identityError: 'username_rename_pending' }, 'username_rename_pending'],
    [Object.assign(new Error(), { code: '23505', constraint: 'accounts_normalized_email_key' }), 'email_unavailable'],
    [Object.assign(new Error(), { code: '23505', constraint: 'accounts_normalized_username_idx' }), 'username_unavailable'],
  ]) await assert.rejects(serviceFixture('admin', result).update({ email: 'a@example.com' }), { code });
});

function repositoryFixture({ stale = false, pending = false, reserved = false, duplicateEmail = false } = {}) {
  const queries = [];
  const row = {
    id: targetId, username: 'Old User', normalized_username: 'old user',
    email: 'typo@example.com', role: 'member', membership_status: 'active',
    created_at: version, updated_at: stale ? now : version,
  };
  const client = {
    release() {},
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT * FROM accounts')) return { rows: [row] };
      if (sql.includes('SELECT id FROM username_rename_requests')) return { rows: pending ? [{ id: 1 }] : [] };
      if (sql.includes('INSERT INTO username_reservations')) return { rows: reserved ? [] : [{ normalized_username: 'new user' }] };
      if (sql.includes('INSERT INTO username_rename_requests')) return { rows: [{ id: 7 }] };
      if (sql.startsWith('UPDATE accounts SET') && duplicateEmail) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      if (sql.includes('SELECT accounts.*, COALESCE')) return { rows: [row] };
      return { rows: [] };
    },
  };
  const repository = createRepository({ connect: async () => client }, { dummyPasswordHash: '' });
  return {
    queries,
    update: (updates) => repository.manageAccount({
      action: 'account.update', actorId, targetId, expectedUpdatedAt: version,
      updatedAt: now, reason: 'Account settings changed', updates,
    }),
  };
}

const corrections = {
  email: 'correct@example.com', normalizedEmail: 'correct@example.com',
  username: 'New User', normalizedUsername: 'new user', displayName: 'New User',
};

test('identity transaction preserves history, resets verification, revokes sessions and audits', async () => {
  const fixture = repositoryFixture();
  await fixture.update(corrections);
  const sql = fixture.queries.map((query) => query.sql).join('\n');
  for (const required of ['INSERT INTO account_username_history', 'email_verified_at = NULL',
    'DELETE FROM email_verification_tokens', 'DELETE FROM password_reset_tokens',
    'UPDATE sessions SET revoked_at', 'INSERT INTO moderation_audit_events']) {
    assert.ok(sql.includes(required), required);
  }
  const audit = fixture.queries.find((query) => query.sql.includes('INSERT INTO moderation_audit_events'));
  assert.equal(JSON.parse(audit.values[4]).before.email, 'typo@example.com');
  assert.equal(JSON.parse(audit.values[4]).before.username, 'Old User');
  assert.equal(fixture.queries.at(-1).sql, 'COMMIT');
});

test('stale versions, pending renames and reserved names do not write the account', async () => {
  for (const options of [{ stale: true }, { pending: true }, { reserved: true }]) {
    const fixture = repositoryFixture(options);
    const result = await fixture.update(corrections);
    assert.ok(result.identityError || result.account === null);
    assert.ok(!fixture.queries.some(({ sql }) => sql.startsWith('UPDATE accounts SET')));
  }
});

test('duplicate email rolls back the entire rename and email transaction', async () => {
  const fixture = repositoryFixture({ duplicateEmail: true });
  await assert.rejects(fixture.update(corrections), { code: '23505' });
  assert.equal(fixture.queries.at(-1).sql, 'ROLLBACK');
  assert.ok(!fixture.queries.some(({ sql }) => sql === 'COMMIT'));
});

test('unchanged email does not clear verification or revoke sessions', async () => {
  const fixture = repositoryFixture();
  await fixture.update({ email: 'typo@example.com', normalizedEmail: 'typo@example.com' });
  assert.ok(!fixture.queries.some(({ sql }) => /email_verified_at = NULL|DELETE FROM.*tokens|UPDATE sessions/.test(sql)));
});
