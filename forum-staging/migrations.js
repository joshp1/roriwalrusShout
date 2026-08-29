import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const migrationNamePattern = /^(\d{4})_[a-z0-9_]+\.sql$/;
const migrationLockId = 1_847_672_019;
const defaultMigrationsUrl = new URL('./migrations/', import.meta.url);

export async function loadMigrations(directoryUrl = defaultMigrationsUrl) {
  const names = (await readdir(directoryUrl))
    .filter((name) => migrationNamePattern.test(name))
    .sort();
  const migrations = await Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, directoryUrl), 'utf8');
    return {
      checksum: createHash('sha256').update(sql).digest('hex'),
      name,
      sql,
      version: Number.parseInt(name.match(migrationNamePattern)[1], 10),
    };
  }));
  const versions = new Set();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

async function ensureMigrationTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version integer PRIMARY KEY,
       name text NOT NULL UNIQUE,
       checksum char(64) NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

function validateAppliedMigrations(migrations, appliedRows) {
  const availableByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  let missingVersionSeen = false;
  const appliedByVersion = new Map(appliedRows.map((migration) => [migration.version, migration]));

  for (const applied of appliedRows) {
    const available = availableByVersion.get(applied.version);
    if (!available || available.name !== applied.name) {
      throw new Error(`Applied migration ${applied.version} is not available`);
    }
    if (available.checksum !== applied.checksum) {
      throw new Error(`Migration ${applied.version} checksum mismatch`);
    }
  }

  for (const migration of migrations) {
    if (!appliedByVersion.has(migration.version)) {
      missingVersionSeen = true;
    } else if (missingVersionSeen) {
      throw new Error(`Migration ${migration.version} was applied after a version gap`);
    }
  }
  return appliedByVersion;
}

export async function runMigrations(pool, { migrations = null } = {}) {
  const availableMigrations = migrations ?? await loadMigrations();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
    await ensureMigrationTable(client);
    const result = await client.query(
      `SELECT version, name, checksum FROM schema_migrations ORDER BY version`,
    );
    const appliedByVersion = validateAppliedMigrations(availableMigrations, result.rows);

    for (const migration of availableMigrations) {
      if (appliedByVersion.has(migration.version)) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
    } finally {
      client.release();
    }
  }
}

export async function assertMigrationsCurrent(pool, { migrations = null } = {}) {
  const availableMigrations = migrations ?? await loadMigrations();
  let result;
  try {
    result = await pool.query(
      `SELECT version, name, checksum FROM schema_migrations ORDER BY version`,
    );
  } catch (error) {
    if (error.code === '42P01') {
      throw new Error('Database migrations have not been applied');
    }
    throw error;
  }
  const appliedByVersion = validateAppliedMigrations(availableMigrations, result.rows);
  if (appliedByVersion.size !== availableMigrations.length) {
    throw new Error('Database migrations are pending');
  }
}