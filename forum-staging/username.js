const usernamePattern = /^(?=.{3,32}$)[a-z0-9][a-z0-9_-]*(?: [a-z0-9_-]+)?$/;

export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidUsername(value) {
  return usernamePattern.test(normalizeUsername(value));
}