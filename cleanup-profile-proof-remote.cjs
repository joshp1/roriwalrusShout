const { existsSync, readFileSync, statSync, unlinkSync } = require('node:fs');
const { Client } = require('pg');

const credentialPath = '/home/roriwalr/forum-staging/.profile-proof-password-a2bcc5f';
const statePath = '/home/roriwalr/forum-staging/.profile-proof-state-a2bcc5f.json';

async function main() {
  if ((statSync(statePath).mode & 0o777) !== 0o600) {
    throw new Error('unsafe profile proof state mode');
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const selector = JSON.parse(readFileSync('/home/roriwalr/.cl.selector/node-selector.json', 'utf8'));
  const databaseUrl = selector['forum-staging']?.env_vars?.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) process.exit(1);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query(`
      SELECT id FROM accounts
      WHERE id = $1 AND username = $2 AND normalized_username = $2
        AND normalized_email = $3 AND role = 'dev' AND visible_to_role IS NULL
      FOR UPDATE
    `, [state.accountId, state.username, state.email]);
    if (account.rowCount !== 1) throw new Error('profile proof account mismatch');
    await client.query('DELETE FROM sessions WHERE account_id = $1', [state.accountId]);
    await client.query('DELETE FROM accounts WHERE id = $1', [state.accountId]);
    await client.query(
      'DELETE FROM username_reservations WHERE normalized_username = $1',
      [state.username],
    );
    const residue = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM accounts WHERE id = $1) AS accounts,
        (SELECT count(*)::integer FROM sessions WHERE account_id = $1) AS sessions,
        (SELECT count(*)::integer FROM username_reservations
          WHERE normalized_username = $2) AS reservations,
        (SELECT count(*)::integer FROM profile_post_comments
          WHERE author_account_id = $1) AS comments,
        (SELECT count(*)::integer FROM profile_visitor_posts
          WHERE profile_account_id = $1 OR author_account_id = $1) AS visitor_posts
    `, [state.accountId, state.username]);
    if (Object.values(residue.rows[0] ?? {}).some((value) => value !== 0)) {
      throw new Error('profile proof cleanup left database residue');
    }
    await client.query('COMMIT');
    unlinkSync(statePath);
    if (existsSync(credentialPath)) unlinkSync(credentialPath);
    process.stdout.write('profile_proof_cleanup=account:0|sessions:0|reservation:0|content:0\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});