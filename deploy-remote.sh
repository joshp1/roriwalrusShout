#!/bin/sh
set -e

root=/home/roriwalr/forum-staging
predecessor_stage="$root/.stage-abb0f6c"
stage="$root/.stage-2b1ce0a"
selector=/home/roriwalr/.cl.selector/node-selector.json
expected_payload_files=175
expected_migration_checksum=030727416f676049e78e6bc4c3fc56541881b53d2cadbbf51e56154426a7a9a7
expected_database_hash=6b85e1092b32acaaec661cba37030010681e6056d292e53a6087a5368a2d8435

test -d "$predecessor_stage"
test -d "$stage"
test -f "$stage/SHA256SUMS"
test -f "$stage/PREDECESSOR-SHA256SUMS"
test -f "$selector"
test "$(stat -c %a "$selector")" = 600
test -f "$root/tmp/restart.txt"
test "$(stat -c %a "$root/tmp/restart.txt")" = 600
test ! -e "$root/recovery-required"
test -z "$(find "$root" -maxdepth 1 -type d -name '.stage-*' ! -path "$predecessor_stage" ! -path "$stage" -print -quit)"
test "$(wc -l < "$stage/SHA256SUMS")" -eq "$expected_payload_files"
(cd "$stage" && sha256sum --check SHA256SUMS >/dev/null)
(cd "$root" && sha256sum --check "$stage/PREDECESSOR-SHA256SUMS" >/dev/null)
test "$(cat "$root/web/deployment-status.json")" = '{"inProgress":false}'

. /home/roriwalr/nodevenv/forum-staging/22/bin/activate
set -u
DATABASE_URL=$(SELECTOR_FILE="$selector" node --input-type=commonjs - <<'NODE'
const { readFileSync } = require('node:fs');
const selector = JSON.parse(readFileSync(process.env.SELECTOR_FILE, 'utf8'));
const databaseUrl = selector['forum-staging']?.env_vars?.DATABASE_URL;
if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) process.exit(1);
process.stdout.write(databaseUrl);
NODE
)
export DATABASE_URL

cd "$root"
STAGE="$stage" EXPECTED_MIGRATION_CHECKSUM="$expected_migration_checksum" node --input-type=commonjs - <<'NODE'
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { Client } = require('pg');

async function main() {
  const expected = readdirSync(`${process.env.STAGE}/migrations`)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      checksum: createHash('sha256').update(readFileSync(`${process.env.STAGE}/migrations/${name}`)).digest('hex'),
      name,
      version: Number.parseInt(name.slice(0, 4), 10),
    }));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const migrations = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    if (migrations.rows.length !== expected.length || expected.length !== 63) throw new Error('unexpected migration count');
    for (let index = 0; index < expected.length; index += 1) {
      const actual = migrations.rows[index];
      const wanted = expected[index];
      if (actual.version !== wanted.version || actual.name !== wanted.name || actual.checksum !== wanted.checksum) {
        throw new Error(`migration mismatch at ${wanted.version}`);
      }
    }
    const tip = migrations.rows.at(-1);
    if (tip.checksum !== process.env.EXPECTED_MIGRATION_CHECKSUM) throw new Error('unexpected migration tip checksum');
    const inventory = await client.query(`SELECT
      (SELECT count(*)::integer FROM shouts WHERE id = 6362) AS control_shouts,
      (SELECT count(*)::integer FROM shouts WHERE body LIKE 'MOD64 % 0.1.49') AS proof_shouts,
      (SELECT count(*)::integer FROM shout_flags WHERE shout_id IN (SELECT id FROM shouts WHERE body LIKE 'MOD64 % 0.1.49')) AS proof_flags`);
    const row = inventory.rows[0];
    if (row.control_shouts !== 1 || row.proof_shouts < 12 || row.proof_flags < 6) throw new Error('proof inventory mismatch');
    process.stdout.write(`migration_contract=count:${expected.length}|tip:${tip.version}|checksum:${tip.checksum}\n`);
    process.stdout.write(`proof_inventory=control:${row.control_shouts}|shouts:${row.proof_shouts}|flags:${row.proof_flags}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE

status_file="$root/web/deployment-status.json"
status_temp=$(mktemp "$root/web/.deployment-status.XXXXXX")
printf '%s' '{"inProgress":true}' > "$status_temp"
chmod 644 "$status_temp"
mv "$status_temp" "$status_file"
test "$(cat "$status_file")" = '{"inProgress":true}'

cp "$stage/database.js" "$root/database.js"
test "$(sha256sum "$root/database.js" | cut -d ' ' -f 1)" = "$expected_database_hash"
grep -v '  ./web/deployment-status.json$' "$stage/SHA256SUMS" \
  | (cd "$root" && sha256sum --check - >/dev/null)
test "$(cat "$status_file")" = '{"inProgress":true}'

restart_before=$(stat -c %y "$root/tmp/restart.txt")
touch "$root/tmp/restart.txt"
restart_after=$(stat -c %y "$root/tmp/restart.txt")
test "$restart_before" != "$restart_after"
readiness=$(curl --fail --silent --show-error --max-time 30 \
  https://test.roriwalrus.net/api/readiness)
test "$readiness" = '{"service":"forum-api","status":"ready"}'

status_temp=$(mktemp "$root/web/.deployment-status.XXXXXX")
printf '%s' '{"inProgress":false}' > "$status_temp"
chmod 644 "$status_temp"
mv "$status_temp" "$status_file"
test "$(cat "$status_file")" = '{"inProgress":false}'
(cd "$root" && sha256sum --check "$stage/SHA256SUMS" >/dev/null)
test ! -e "$root/recovery-required"
printf 'backup=not-required-code-only\n'
printf 'active_hashes=%s\n' "$expected_payload_files"
printf 'deployment_status=true-before-replacement|false-after-readiness\n'
printf 'passenger_restart_touches=1\n'
printf 'restart_before=%s\n' "$restart_before"
printf 'restart_after=%s\n' "$restart_after"
printf 'readiness=%s\n' "$readiness"