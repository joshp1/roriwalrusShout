import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdministrationService } from '../administration.js';
import { createAuthService } from '../auth.js';

const targetId = '00000000-0000-4000-8000-000000000002';
const version = '2026-09-06T00:00:00.000Z';
function fixture({ role = 'admin', csrf = true, conflict = false, sent = true } = {}) {
  const calls = [];
  const account = { id: targetId, email: 'member@example.com', role: 'member', membershipStatus: 'active' };
  const service = createAdministrationService({
    authService: {
      getSession: async () => ({ account: { id: '00000000-0000-4000-8000-000000000001', role, permissions: ['users.moderate'] } }),
      requireCsrf: async () => { if (!csrf) throw new Error('csrf'); },
      requestPasswordReset: async (email) => { calls.push(email); return sent; },
    },
    repository: {
      findManagedAccount: async () => account,
      manageAccount: async (mutation) => { calls.push(mutation); return { account: conflict ? null : account }; },
    },
  });
  return { calls, send: () => service.sendPasswordReset('session', 'csrf', targetId, { expectedUpdatedAt: version }) };
}

test('admin reset sends to the stored email and audits without locking the account', async () => {
  const f = fixture();
  await f.send();
  assert.equal(f.calls[0].action, 'account.send_password_reset');
  assert.deepEqual(f.calls[0].updates, {});
  assert.equal(f.calls[1], 'member@example.com');
});

test('moderators, invalid CSRF, and stale account versions cannot send reset emails', async () => {
  for (const options of [{ role: 'moderator' }, { csrf: false }, { conflict: true }]) {
    const f = fixture(options);
    await assert.rejects(f.send());
    assert.equal(f.calls.some((call) => typeof call === 'string'), false);
  }
});

test('unavailable reset is reported to the admin', async () => {
  await assert.rejects(fixture({ sent: false }).send(), { code: 'password_reset_unavailable' });
});

test('recovery mails only eligible accounts and stores a digest with a one hour expiry', async () => {
  for (const eligible of [true, false]) {
    const stored = [], mailed = [];
    const service = createAuthService({
      clock: () => new Date(version), publicOrigin: 'https://example.com',
      randomToken: () => 'a'.repeat(43),
      repository: {
        consumeRateLimit: async () => true,
        findAccountByEmail: async () => ({ id: targetId, email: 'member@example.com', emailVerifiedAt: eligible ? version : null, membershipStatus: 'active' }),
        replacePasswordResetToken: async (...args) => stored.push(args),
      },
      mailer: { sendPasswordReset: async (mail) => mailed.push(mail) },
    });
    assert.equal(await service.requestPasswordReset('member@example.com'), eligible ? true : undefined);
    assert.equal(mailed.length, eligible ? 1 : 0);
    if (eligible) {
      assert.notEqual(stored[0][1], 'a'.repeat(43));
      assert.equal(stored[0][2].getTime() - new Date(version).getTime(), 3600000);
      assert.equal(mailed[0].email, 'member@example.com');
    }
  }
});
