import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const inviteTokenPattern = /^roriwalrus-[A-Za-z0-9_-]{16}$/;
const saltLength = 16;
const verifierLength = 32;

export function createRegistrationInviteToken() {
  return `roriwalrus-${randomBytes(12).toString('base64url')}`;
}

export function createRegistrationInviteSalt() {
  return randomBytes(saltLength);
}

export function digestRegistrationInviteToken(value) {
  if (typeof value !== 'string' || !inviteTokenPattern.test(value)) {
    return null;
  }
  return createHash('sha256').update(value).digest('hex');
}

export async function deriveRegistrationInviteVerifier(value, salt) {
  if (!digestRegistrationInviteToken(value) || !Buffer.isBuffer(salt) || salt.length !== saltLength) {
    return null;
  }
  return deriveKey(value, salt, verifierLength);
}

export async function verifyRegistrationInviteToken(value, salt, expectedVerifier) {
  if (!Buffer.isBuffer(expectedVerifier) || expectedVerifier.length !== verifierLength) {
    return false;
  }
  const verifier = await deriveRegistrationInviteVerifier(value, salt);
  return Buffer.isBuffer(verifier)
    && verifier.length === expectedVerifier.length
    && timingSafeEqual(verifier, expectedVerifier);
}