import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPasswordHasher } from './auth.js';
import { createDatabasePool } from './database.js';
import { runMigrations } from './migrations.js';
import { isValidUsername, normalizeUsername } from './username.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const testerUsername = 'dev-bot';

function validateInput({ email: inputEmail, password, username: inputUsername }) {
  const email = typeof inputEmail === 'string' ? inputEmail.trim().toLowerCase() : '';
  const username = typeof inputUsername === 'string' ? inputUsername.trim() : '';
  if (email.length > 254 || !emailPattern.test(email)) {
    throw new Error('invalid_tester_email');
  }
  if (username !== testerUsername || !isValidUsername(username)) {
    throw new Error('invalid_tester_username');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('invalid_tester_password');
  }
  return { email, normalizedUsername: normalizeUsername(username), password, username };
}

export async function provisionDevTester(pool, input, {
  idFactory = randomUUID,
  passwordHasher = createPasswordHasher(),
} = {}) {
  const { email, normalizedUsername, password, username } = validateInput(input);
  const passwordHash = await passwordHasher.hash(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query(
      `SELECT id, normalized_email, normalized_username, visible_to_role
       FROM accounts
       WHERE normalized_username = $1 OR normalized_email = $2
       FOR UPDATE`,
      [normalizedUsername, email],
    );
    if (existingResult.rows.length > 1) {
      throw new Error('tester_identity_conflict');
    }
    const existing = existingResult.rows[0];
    if (existing && (
      existing.normalized_email !== email
      || existing.normalized_username !== normalizedUsername
      || existing.visible_to_role !== 'dev'
    )) {
      throw new Error('tester_identity_conflict');
    }

    let accountId = existing?.id;
    if (existing) {
      await client.query(
        `UPDATE accounts
         SET email = $2, normalized_email = $2, username = $3,
           normalized_username = $4, display_name = $3, password_hash = $5,
           role = 'dev', visible_to_role = 'dev', membership_status = 'active',
           email_verified_at = COALESCE(email_verified_at, now()),
           force_password_change = false, deleted_at = NULL,
           forum_posting_muted = false, shoutbox_enabled = true,
           shoutbox_posting_muted = false, updated_at = now()
         WHERE id = $1`,
        [accountId, email, username, normalizedUsername, passwordHash],
      );
      await client.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [accountId],
      );
    } else {
      const reservation = await client.query(
        `INSERT INTO username_reservations (normalized_username)
         VALUES ($1) ON CONFLICT DO NOTHING RETURNING normalized_username`,
        [normalizedUsername],
      );
      if (!reservation.rows[0]) {
        throw new Error('tester_identity_conflict');
      }
      accountId = idFactory();
      await client.query(
        `INSERT INTO accounts (
           id, email, normalized_email, username, normalized_username,
           display_name, role, password_hash, email_verified_at,
           membership_status, visible_to_role
         ) VALUES ($1, $2, $2, $3, $4, $3, 'dev', $5, now(), 'active', 'dev')`,
        [accountId, email, username, normalizedUsername, passwordHash],
      );
    }
    await client.query(
      `INSERT INTO authentication_audit_events (account_id, action, details)
       VALUES ($1, 'auth.dev_tester.provisioned', $2::jsonb)`,
      [accountId, JSON.stringify({ created: !existing })],
    );
    await client.query('COMMIT');
    return { created: !existing, id: accountId, username };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function provisionDevTesterDatabase(databaseUrl, input) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = createDatabasePool(databaseUrl, { statementTimeout: 0 });
  try {
    await runMigrations(pool);
    return await provisionDevTester(pool, input);
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  provisionDevTesterDatabase(process.env.DATABASE_URL, {
    email: process.env.TESTER_EMAIL,
    password: process.env.TESTER_PASSWORD,
    username: process.env.TESTER_USERNAME,
  }).then((result) => {
    console.log(`Dev tester ${result.created ? 'created' : 'updated'}: ${result.username}`);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}