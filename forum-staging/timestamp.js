const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !isoTimestampPattern.test(value)) {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value
    ? null
    : timestamp;
}