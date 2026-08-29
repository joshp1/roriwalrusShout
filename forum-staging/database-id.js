const maximumDatabaseId = 9_223_372_036_854_775_807n;

export function normalizeDatabaseId(value) {
  if (!['number', 'string'].includes(typeof value)) {
    return null;
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) {
    return null;
  }
  const text = String(value);
  if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > maximumDatabaseId) {
    return null;
  }
  return text;
}