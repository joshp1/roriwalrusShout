import {
  constants,
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const forumRestartMinimumIntervalMs = 5 * 60 * 1000;

export class ForumRestartError extends Error {
  constructor(code, statusCode, retryAfterMs) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
    if (retryAfterMs > 0) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

function restartError(code, statusCode, retryAfterMs) {
  return new ForumRestartError(code, statusCode, retryAfterMs);
}

function resolveRestartConfiguration(markerPath, minimumIntervalMs) {
  if (
    typeof markerPath !== 'string'
    || !isAbsolute(markerPath)
    || !Number.isSafeInteger(minimumIntervalMs)
    || minimumIntervalMs < 60_000
  ) {
    throw new Error('invalid_forum_restart_configuration');
  }
  const resolvedMarkerPath = resolve(markerPath);
  return {
    markerDirectory: dirname(resolvedMarkerPath),
    minimumIntervalMs,
    resolvedMarkerPath,
  };
}

async function openRestartMarker({ markerDirectory, resolvedMarkerPath }) {
  if (await realpath(markerDirectory) !== markerDirectory) {
    throw restartError('forum_restart_unavailable', 503);
  }
  const markerBeforeOpen = await lstat(resolvedMarkerPath);
  if (!markerBeforeOpen.isFile()) {
    throw restartError('forum_restart_unavailable', 503);
  }
  const markerHandle = await open(
    resolvedMarkerPath,
    constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const marker = await markerHandle.stat();
    if (!marker.isFile()) {
      throw restartError('forum_restart_unavailable', 503);
    }
    return { marker, markerHandle };
  } catch (error) {
    await markerHandle.close().catch(() => {});
    throw error;
  }
}

export async function validateForumRestartMarker(markerPath) {
  const configuration = resolveRestartConfiguration(
    markerPath,
    forumRestartMinimumIntervalMs,
  );
  let markerHandle;
  try {
    ({ markerHandle } = await openRestartMarker(configuration));
  } catch {
    throw new Error('invalid_forum_restart_configuration');
  } finally {
    await markerHandle?.close().catch(() => {});
  }
}

export function createForumRestart({
  markerPath,
  minimumIntervalMs = forumRestartMinimumIntervalMs,
  now = () => new Date(),
}) {
  const configuration = resolveRestartConfiguration(markerPath, minimumIntervalMs);

  return async function restartForum({ requestedAt = now() } = {}) {
    if (!(requestedAt instanceof Date) || !Number.isFinite(requestedAt.getTime())) {
      throw restartError('forum_restart_unavailable', 503);
    }
    let markerHandle;
    try {
      const openedMarker = await openRestartMarker(configuration);
      markerHandle = openedMarker.markerHandle;
      const { marker } = openedMarker;
      const retryAfterMs = Math.max(0, minimumIntervalMs - (requestedAt.getTime() - marker.mtimeMs));
      if (retryAfterMs > 0) {
        throw restartError('forum_restart_cooldown', 429, retryAfterMs);
      }
      await markerHandle.utimes(requestedAt, requestedAt);
      return { requestedAt };
    } catch (error) {
      if (error instanceof ForumRestartError) {
        throw error;
      }
      throw restartError('forum_restart_unavailable', 503);
    } finally {
      await markerHandle?.close().catch(() => {});
    }
  };
}