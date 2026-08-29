import { createHash, randomBytes } from 'node:crypto';

const unlockCodePattern = /^[A-Za-z0-9_-]{43}$/;

export const usernameColorEffects = Object.freeze(['none', 'rainbow', 'rainbow-roll']);

export function createUsernameColorUnlockCode() {
  return randomBytes(32).toString('base64url');
}

export function digestUsernameColorUnlockCode(value) {
  if (typeof value !== 'string' || !unlockCodePattern.test(value)) {
    return null;
  }
  return createHash('sha256').update(value).digest('hex');
}