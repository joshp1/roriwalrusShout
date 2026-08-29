export function createWebPushRepository(pool, { maximumSubscriptionsPerAccount = 10 } = {}) {
  return Object.freeze({
    async claimDeliveries({ leaseToken, leaseUntil, limit, now }) {
      const result = await pool.query(
        `WITH candidates AS (
           SELECT deliveries.id
           FROM web_push_deliveries deliveries
           JOIN notifications ON notifications.id = deliveries.notification_id
           JOIN web_push_subscriptions subscriptions
             ON subscriptions.id = deliveries.subscription_id
           WHERE deliveries.delivered_at IS NULL
             AND deliveries.discarded_at IS NULL
             AND deliveries.available_at <= $1
             AND (deliveries.lease_until IS NULL OR deliveries.lease_until < $1)
             AND notifications.account_id = subscriptions.account_id
             AND (
               notifications.required_permission IS NULL
               OR notifications.required_permission = 'shouts.moderate'
                 AND shoutbox_stream_visible_to(subscriptions.account_id, 'staff')
             )
             AND (
               notifications.forum_topic_id IS NULL
               OR forum_topic_visible_to(
                 subscriptions.account_id,
                 notifications.forum_topic_id
               )
             )
             AND (
               notifications.shout_id IS NULL
               OR shout_visible_to(
                 subscriptions.account_id,
                 notifications.shout_id
               )
             )
           ORDER BY deliveries.available_at, deliveries.id
           FOR UPDATE OF deliveries SKIP LOCKED
           LIMIT $2
         )
         UPDATE web_push_deliveries deliveries
         SET lease_token = $3, lease_until = $4
         FROM candidates, web_push_subscriptions subscriptions
         WHERE deliveries.id = candidates.id
           AND subscriptions.id = deliveries.subscription_id
         RETURNING deliveries.id, deliveries.notification_id,
           deliveries.subscription_id, deliveries.attempts,
           subscriptions.endpoint, subscriptions.p256dh, subscriptions.auth`,
        [now, limit, leaseToken, leaseUntil],
      );
      return result.rows.map((row) => ({
        attempts: row.attempts,
        auth: row.auth,
        endpoint: row.endpoint,
        id: row.id,
        notificationId: row.notification_id,
        p256dh: row.p256dh,
        subscriptionId: row.subscription_id,
      }));
    },
    async deleteSubscription(accountId, endpoint) {
      await pool.query(
        `DELETE FROM web_push_subscriptions
         WHERE account_id = $1 AND endpoint = $2`,
        [accountId, endpoint],
      );
    },
    async expireSubscription({ deliveryId, leaseToken }) {
      await pool.query(
        `DELETE FROM web_push_subscriptions
         WHERE id = (
           SELECT subscription_id FROM web_push_deliveries
           WHERE id = $1 AND lease_token = $2
         )`,
        [deliveryId, leaseToken],
      );
    },
    async markDelivered({ deliveredAt, deliveryId, leaseToken }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE web_push_deliveries
           SET delivered_at = $3, lease_token = NULL, lease_until = NULL,
             last_status = 201, last_error = NULL
           WHERE id = $1 AND lease_token = $2
           RETURNING subscription_id`,
          [deliveryId, leaseToken, deliveredAt],
        );
        if (result.rows[0]) {
          await client.query(
            `UPDATE web_push_subscriptions
             SET failure_count = 0, last_success_at = $2, updated_at = $2
             WHERE id = $1`,
            [result.rows[0].subscription_id, deliveredAt],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async recordFailure({
      attempts,
      availableAt,
      deliveryId,
      discardedAt,
      errorCode,
      leaseToken,
      statusCode,
    }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE web_push_deliveries
           SET attempts = $3, available_at = $4,
             discarded_at = $5, last_status = $6, last_error = $7,
             lease_token = NULL, lease_until = NULL
           WHERE id = $1 AND lease_token = $2
           RETURNING subscription_id`,
          [
            deliveryId,
            leaseToken,
            attempts,
            availableAt,
            discardedAt,
            statusCode,
            errorCode,
          ],
        );
        if (result.rows[0]) {
          await client.query(
            `UPDATE web_push_subscriptions
             SET failure_count = failure_count + 1, updated_at = $2
             WHERE id = $1`,
            [result.rows[0].subscription_id, availableAt],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async upsertSubscription(accountId, subscription) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM web_push_subscriptions
           WHERE endpoint = $1 AND account_id <> $2`,
          [subscription.endpoint, accountId],
        );
        await client.query(
          `INSERT INTO web_push_subscriptions (
             account_id, endpoint, expiration_time_ms, p256dh, auth
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (endpoint) DO UPDATE
           SET expiration_time_ms = EXCLUDED.expiration_time_ms,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             failure_count = 0,
             updated_at = now()`,
          [
            accountId,
            subscription.endpoint,
            subscription.expirationTime,
            subscription.p256dh,
            subscription.auth,
          ],
        );
        await client.query(
          `DELETE FROM web_push_subscriptions
           WHERE id IN (
             SELECT id FROM web_push_subscriptions
             WHERE account_id = $1
             ORDER BY updated_at DESC, id DESC
             OFFSET $2
           )`,
          [accountId, maximumSubscriptionsPerAccount],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  });
}