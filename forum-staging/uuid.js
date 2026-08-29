export const canonicalUuidPath = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

const canonicalUuidPattern = new RegExp(`^${canonicalUuidPath}$`, 'i');

export function isCanonicalUuid(value) {
  return typeof value === 'string' && canonicalUuidPattern.test(value);
}