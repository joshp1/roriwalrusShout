#!/bin/sh
set -e

. /home/roriwalr/nodevenv/forum-staging/22/bin/activate

SELECTOR_FILE=/home/roriwalr/.cl.selector/node-selector.json \
  APPLICATION_ROOT=/home/roriwalr/forum-staging node --input-type=commonjs - <<'NODE'
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const selector = JSON.parse(readFileSync(process.env.SELECTOR_FILE, 'utf8'));
const configured = selector['forum-staging']?.env_vars ?? {};
const required = ['DATABASE_URL', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
for (const name of required) {
  if (typeof configured[name] !== 'string' || configured[name].length === 0) {
    throw new Error(`${name} is not configured`);
  }
}
const result = spawnSync(process.execPath, ['send-web-push.js'], {
  cwd: process.env.APPLICATION_ROOT,
  env: {
    ...process.env,
    DATABASE_URL: configured.DATABASE_URL,
    VAPID_PRIVATE_KEY: configured.VAPID_PRIVATE_KEY,
    VAPID_PUBLIC_KEY: configured.VAPID_PUBLIC_KEY,
    VAPID_SUBJECT: configured.VAPID_SUBJECT,
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
NODE