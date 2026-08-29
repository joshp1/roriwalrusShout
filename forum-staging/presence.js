import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const acceptanceWindowMs = 3_000;
const completionLifetimeMs = 12 * 60 * 60 * 1000;
const maximumTargetMs = 37_000;
const minimumTargetMs = 7_000;

export class PresenceError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export function createRandomPresenceTargetMs(randomInteger = randomInt) {
  return randomInteger(minimumTargetMs, maximumTargetMs + 1);
}

export function createPresenceService({
  clock = () => new Date(),
  randomTargetMs = createRandomPresenceTargetMs,
  secret = randomBytes(32),
} = {}) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);

  function sign(payload) {
    const encoded = encode(payload);
    const signature = createHmac('sha256', key).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  function verify(token, type) {
    if (typeof token !== 'string') {
      return null;
    }
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) {
      return null;
    }
    const expected = createHmac('sha256', key).update(encoded).digest();
    let actual;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return null;
    }
    try {
      const payload = decode(encoded);
      return payload.type === type ? payload : null;
    } catch {
      return null;
    }
  }

  function createChallenge(completionToken) {
    if (isComplete(completionToken)) {
      return { required: false };
    }
    const targetMs = randomTargetMs();
    return {
      required: true,
      targetMs,
      token: sign({
        issuedAt: clock().getTime(),
        nonce: randomBytes(16).toString('base64url'),
        targetMs,
        type: 'challenge',
      }),
      windowMs: acceptanceWindowMs,
    };
  }

  function completeChallenge(token) {
    const challenge = verify(token, 'challenge');
    if (!challenge) {
      throw new PresenceError('invalid_presence_challenge', 400);
    }
    const elapsedMs = clock().getTime() - challenge.issuedAt;
    if (elapsedMs < challenge.targetMs) {
      throw new PresenceError('presence_too_early', 409);
    }
    if (elapsedMs > challenge.targetMs + acceptanceWindowMs) {
      throw new PresenceError('presence_challenge_expired', 410);
    }
    return sign({
      expiresAt: clock().getTime() + completionLifetimeMs,
      type: 'completion',
    });
  }

  function isComplete(token) {
    const completion = verify(token, 'completion');
    return Boolean(completion && completion.expiresAt > clock().getTime());
  }

  return { completeChallenge, createChallenge, isComplete };
}