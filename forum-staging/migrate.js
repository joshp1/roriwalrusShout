import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabasePool } from './database.js';
import { runMigrations } from './migrations.js';

export async function migrateDatabase(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = createDatabasePool(databaseUrl, { statementTimeout: 0 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  migrateDatabase(process.env.DATABASE_URL).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}