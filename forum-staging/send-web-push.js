import { randomUUID } from 'node:crypto';
import webPush from 'web-push';
import { createDatabasePool } from './database.js';
import { assertMigrationsCurrent } from './migrations.js';
import { createWebPushSender, loadWebPushConfiguration } from './web-push.js';
import { createWebPushRepository } from './web-push-database.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  const configuration = loadWebPushConfiguration();
  if (!configuration.available) {
    throw new Error('Web Push is not configured');
  }
  const batchLimit = Number.parseInt(process.env.WEB_PUSH_BATCH_SIZE ?? '50', 10);
  const pool = createDatabasePool(process.env.DATABASE_URL, { statementTimeout: 0 });
  try {
    await assertMigrationsCurrent(pool);
    const sender = createWebPushSender({
      configuration,
      leaseTokenFactory: randomUUID,
      repository: createWebPushRepository(pool),
      sendNotification: webPush.sendNotification.bind(webPush),
    });
    const totals = { claimed: 0, delivered: 0, discarded: 0, expired: 0, retried: 0 };
    for (let batchNumber = 0; batchNumber < 20; batchNumber += 1) {
      const batch = await sender.runBatch(batchLimit);
      for (const key of Object.keys(totals)) totals[key] += batch[key];
      if (batch.claimed < batchLimit) break;
    }
    process.stdout.write(`${JSON.stringify({ event: 'web_push.completed', ...totals })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'web_push.failed', message: error.message })}\n`);
  process.exitCode = 1;
});