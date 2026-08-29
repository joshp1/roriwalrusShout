const allowedMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const allowedAreas = new Set([
  'account',
  'admin',
  'auth',
  'direct_messages',
  'forum',
  'health',
  'notifications',
  'presence',
  'profile',
  'readiness',
  'static',
  'unknown',
]);

function boundedIdentifier(value, fallback = 'unknown') {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : fallback;
}

function requestFields({ area, durationMs, method, requestId, statusCode }) {
  return {
    requestId: boundedIdentifier(requestId),
    method: allowedMethods.has(method) ? method : 'OTHER',
    area: allowedAreas.has(area) ? area : 'unknown',
    statusCode: Number.isSafeInteger(statusCode) ? statusCode : 500,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0
      ? Math.round(durationMs)
      : 0,
  };
}

export function createNullLogger() {
  return {
    httpRequestAborted() {},
    httpRequestCompleted() {},
    httpRequestFailed() {},
    serviceStartFailed() {},
    serviceStarted() {},
  };
}

export function createJsonLogger({
  clock = () => new Date(),
  stderr = (line) => process.stderr.write(line),
  stdout = (line) => process.stdout.write(line),
} = {}) {
  function emit(level, event, fields = {}) {
    const line = `${JSON.stringify({
      timestamp: clock().toISOString(),
      level,
      service: 'forum-api',
      event,
      ...fields,
    })}\n`;
    (level === 'error' ? stderr : stdout)(line);
  }

  return {
    httpRequestAborted(input) {
      emit('error', 'http.request.aborted', requestFields(input));
    },
    httpRequestCompleted(input) {
      const fields = requestFields(input);
      const level = fields.statusCode >= 500
        ? 'error'
        : fields.statusCode >= 400 ? 'warn' : 'info';
      emit(level, 'http.request.completed', fields);
    },
    httpRequestFailed({ error, requestId }) {
      emit('error', 'http.request.failed', {
        requestId: boundedIdentifier(requestId),
        errorName: boundedIdentifier(error?.name, 'Error'),
        errorCode: boundedIdentifier(error?.code, 'unexpected_error'),
      });
    },
    serviceStartFailed(error) {
      emit('error', 'service.start_failed', {
        errorName: boundedIdentifier(error?.name, 'Error'),
        errorCode: boundedIdentifier(error?.code, 'startup_error'),
      });
    },
    serviceStarted() {
      emit('info', 'service.started');
    },
  };
}