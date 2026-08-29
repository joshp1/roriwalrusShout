const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const maximumEndpointLength = 2048;
const maximumAttempts = 8;
const leaseDurationMs = 2 * 60 * 1000;

export class WebPushError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function decodeKey(value, expectedBytes) {
  if (
    typeof value !== 'string'
    || !base64UrlPattern.test(value)
    || Buffer.from(value, 'base64url').length !== expectedBytes
  ) {
    throw new WebPushError('invalid_push_subscription', 400);
  }
  return value;
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.length > maximumEndpointLength) {
    throw new WebPushError('invalid_push_subscription', 400);
  }
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
      throw new Error('invalid endpoint');
    }
    return endpoint.href;
  } catch {
    throw new WebPushError('invalid_push_subscription', 400);
  }
}

export function normalizeWebPushSubscription(input) {
  if (!input || typeof input !== 'object' || !input.keys || typeof input.keys !== 'object') {
    throw new WebPushError('invalid_push_subscription', 400);
  }
  const expirationTime = input.expirationTime ?? null;
  if (
    expirationTime !== null
    && (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)
  ) {
    throw new WebPushError('invalid_push_subscription', 400);
  }
  return Object.freeze({
    auth: decodeKey(input.keys.auth, 16),
    endpoint: normalizeEndpoint(input.endpoint),
    expirationTime,
    p256dh: decodeKey(input.keys.p256dh, 65),
  });
}

function validateVapidKey(value, expectedBytes, name) {
  if (
    typeof value !== 'string'
    || !base64UrlPattern.test(value)
    || Buffer.from(value, 'base64url').length !== expectedBytes
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function loadWebPushConfiguration(environment = process.env) {
  const subject = environment.VAPID_SUBJECT;
  const publicKey = environment.VAPID_PUBLIC_KEY;
  const privateKey = environment.VAPID_PRIVATE_KEY;
  if (!subject && !publicKey && !privateKey) {
    return Object.freeze({ available: false, privateKey: null, publicKey: null, subject: null });
  }
  if (!subject || !publicKey || !privateKey) {
    throw new Error('VAPID_SUBJECT, VAPID_PUBLIC_KEY, and VAPID_PRIVATE_KEY must be configured together');
  }
  let subjectUrl;
  try {
    subjectUrl = new URL(subject);
  } catch {
    throw new Error('VAPID_SUBJECT must be a mailto or HTTPS URL');
  }
  if (!['https:', 'mailto:'].includes(subjectUrl.protocol)) {
    throw new Error('VAPID_SUBJECT must be a mailto or HTTPS URL');
  }
  return Object.freeze({
    available: true,
    privateKey: validateVapidKey(privateKey, 32, 'VAPID_PRIVATE_KEY'),
    publicKey: validateVapidKey(publicKey, 65, 'VAPID_PUBLIC_KEY'),
    subject,
  });
}

export function createWebPushService({ authService, configuration, repository }) {
  return Object.freeze({
    async getConfiguration(sessionToken) {
      await authService.getSession(sessionToken);
      return {
        available: configuration.available,
        publicKey: configuration.publicKey,
      };
    },
    async subscribe(sessionToken, csrfToken, input) {
      const session = await authService.getSession(sessionToken);
      await authService.requireCsrf(session, csrfToken);
      if (!configuration.available) {
        throw new WebPushError('push_unavailable', 503);
      }
      const subscription = normalizeWebPushSubscription(input);
      await repository.upsertSubscription(session.account.id, subscription);
      return { subscribed: true };
    },
    async unsubscribe(sessionToken, csrfToken, input) {
      const session = await authService.getSession(sessionToken);
      await authService.requireCsrf(session, csrfToken);
      const endpoint = normalizeEndpoint(input?.endpoint);
      await repository.deleteSubscription(session.account.id, endpoint);
      return { subscribed: false };
    },
  });
}

function failureStatus(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : null;
}

function isTransientFailure(statusCode) {
  return statusCode === null || statusCode === 429 || statusCode >= 500;
}

function retryDelayMs(attempts) {
  return Math.min(24 * 60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempts - 1)));
}

export function createWebPushSender({
  clock = () => new Date(),
  configuration,
  leaseTokenFactory,
  repository,
  sendNotification,
}) {
  if (!configuration.available) {
    throw new Error('Web Push sender requires VAPID configuration');
  }
  return Object.freeze({
    async runBatch(limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Web Push batch limit must be between 1 and 100');
      }
      const startedAt = clock();
      const leaseToken = leaseTokenFactory();
      const deliveries = await repository.claimDeliveries({
        leaseToken,
        leaseUntil: new Date(startedAt.getTime() + leaseDurationMs),
        limit,
        now: startedAt,
      });
      const summary = {
        claimed: deliveries.length,
        delivered: 0,
        discarded: 0,
        expired: 0,
        retried: 0,
      };
      for (const delivery of deliveries) {
        const payload = JSON.stringify({
          body: 'You have a new notification.',
          tag: `rw-notification-${delivery.notificationId}`,
          title: 'roriwalrus',
          url: '/notifications',
        });
        try {
          await sendNotification({
            endpoint: delivery.endpoint,
            keys: { auth: delivery.auth, p256dh: delivery.p256dh },
          }, payload, {
            TTL: 24 * 60 * 60,
            urgency: 'normal',
            vapidDetails: {
              privateKey: configuration.privateKey,
              publicKey: configuration.publicKey,
              subject: configuration.subject,
            },
          });
          await repository.markDelivered({
            deliveredAt: clock(),
            deliveryId: delivery.id,
            leaseToken,
          });
          summary.delivered += 1;
        } catch (error) {
          const statusCode = failureStatus(error);
          if ([404, 410].includes(statusCode)) {
            await repository.expireSubscription({ deliveryId: delivery.id, leaseToken });
            summary.expired += 1;
            continue;
          }
          const attempts = delivery.attempts + 1;
          const transient = isTransientFailure(statusCode) && attempts < maximumAttempts;
          const failedAt = clock();
          await repository.recordFailure({
            attempts,
            availableAt: transient
              ? new Date(failedAt.getTime() + retryDelayMs(attempts))
              : failedAt,
            deliveryId: delivery.id,
            discardedAt: transient ? null : failedAt,
            errorCode: statusCode === null ? 'push_network' : `push_http_${statusCode}`,
            leaseToken,
            statusCode,
          });
          if (transient) summary.retried += 1;
          else summary.discarded += 1;
        }
      }
      return summary;
    },
  });
}