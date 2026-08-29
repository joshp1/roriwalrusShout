import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabasePool } from './database.js';
import { assertMigrationsCurrent } from './migrations.js';
import { parseIsoTimestamp } from './timestamp.js';

const cutoffFormat = 'YYYY-MM-DDTHH:mm:ss.sssZ';

export function parseNotificationCleanupArguments(arguments_, clock = () => new Date()) {
  if (arguments_.length !== 1 || !arguments_[0].startsWith('--before=')) {
    throw new Error(`Exactly one --before=${cutoffFormat} cutoff is required`);
  }
  const before = parseIsoTimestamp(arguments_[0].slice('--before='.length));
  if (!before || before.getTime() > clock().getTime()) {
    throw new Error(`--before must be a canonical non-future UTC timestamp (${cutoffFormat})`);
  }
  return before;
}

export async function deleteNotificationsBefore(pool, before) {
  const result = await pool.query(
    `DELETE FROM notifications
     WHERE created_at < $1::timestamptz`,
    [before.toISOString()],
  );
  return Number(result.rowCount ?? 0);
}

export function formatNotificationCleanupError(error) {
  const message = error instanceof Error ? error.message : '';
  if (
    message.includes('--before')
    || message === 'DATABASE_URL is required'
    || message.startsWith('Database migrations ')
  ) {
    return message;
  }
  return 'Notification cleanup failed';
}

export async function runNotificationCleanup({
  assertCurrent = assertMigrationsCurrent,
  before,
  databaseUrl,
  output = console.log,
  poolFactory = createDatabasePool,
}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = poolFactory(databaseUrl);
  try {
    await assertCurrent(pool);
    const deletedCount = await deleteNotificationsBefore(pool, before);
    const result = { before: before.toISOString(), deletedCount };
    await output(JSON.stringify({ event: 'notifications.cleanup.completed', ...result }));
    return result;
  } finally {
    await pool.end();
  }
}

async function main() {
  const before = parseNotificationCleanupArguments(process.argv.slice(2));
  await runNotificationCleanup({ before, databaseUrl: process.env.DATABASE_URL });
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(formatNotificationCleanupError(error));
    process.exitCode = 1;
  });
}