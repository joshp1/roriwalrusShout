import { isIP } from 'node:net';

export function createFixedWindowLimiter({ clock = () => Date.now(), maximumEntries = 10_000 } = {}) {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new TypeError('Invalid request limit capacity');
  }
  const entries = new Map();

  function makeCapacity(now) {
    let retryAfterMs = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      const remainingMs = entry.windowMs - (now - entry.startedAt);
      if (remainingMs <= 0) {
        entries.delete(key);
      } else {
        retryAfterMs = Math.min(retryAfterMs, remainingMs);
      }
    }
    return entries.size < maximumEntries ? null : Math.max(1, retryAfterMs);
  }

  return {
    consume(key, { limit, windowMs }) {
      if (
        typeof key !== 'string'
        || key.length === 0
        || !Number.isSafeInteger(limit)
        || limit < 1
        || !Number.isSafeInteger(windowMs)
        || windowMs < 1
      ) {
        throw new TypeError('Invalid request limit');
      }
      const now = clock();
      let entry = entries.get(key);
      if (!entry || now - entry.startedAt >= windowMs) {
        if (!entry) {
          const capacityRetryAfterMs = makeCapacity(now);
          if (capacityRetryAfterMs !== null) {
            return { allowed: false, retryAfterMs: capacityRetryAfterMs };
          }
        }
        entry = { count: 0, startedAt: now, windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= limit,
        retryAfterMs: Math.max(1, windowMs - (now - entry.startedAt)),
      };
    },
  };
}

function normalizedAddress(value) {
  const address = typeof value === 'string' ? value.trim() : '';
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) {
    return address.slice(7);
  }
  return isIP(address) ? address : '';
}

export function createTrustedProxyAddresses(value, enabled = false) {
  if (!enabled) {
    return new Set();
  }
  const values = typeof value === 'string' ? value.split(',') : [];
  const addresses = values.map(normalizedAddress).filter(Boolean);
  if (addresses.length !== values.length || addresses.length === 0) {
    throw new Error('TRUSTED_PROXY_ADDRESSES must contain valid IP addresses');
  }
  return new Set(addresses);
}

export function getClientAddress(request, trustedProxyAddresses = new Set()) {
  const socketAddress = normalizedAddress(request.socket.remoteAddress);
  if (trustedProxyAddresses.has(socketAddress)) {
    const forwardedFor = request.headers['x-forwarded-for'];
    const firstAddress = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
      ?.split(',')[0]
      .trim();
    const clientAddress = normalizedAddress(firstAddress);
    if (clientAddress) {
      return clientAddress;
    }
  }
  return socketAddress || 'unknown';
}