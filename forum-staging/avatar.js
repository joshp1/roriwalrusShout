import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { Decoder, tools } from 'ts-ebml';

export const maximumAvatarBytes = 1024 * 1024;
const maximumAvatarPixels = 16_777_216;

const allowedMediaTypes = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/webm',
]);
const supportedWebmVideoCodecs = new Set(['V_AV1', 'V_VP8', 'V_VP9']);

export class AvatarError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function hasCompletedMaster(elements, name) {
  let openElements = 0;
  for (const element of elements) {
    if (element.type !== 'm' || element.name !== name) {
      continue;
    }
    if (!element.isEnd) {
      openElements += 1;
    } else if (openElements > 0) {
      return true;
    }
  }
  return false;
}

function collectVideoTrackNumbers(elements) {
  const trackNumbers = new Set();
  let currentTrack = null;
  for (const element of elements) {
    if (element.type === 'm' && element.name === 'TrackEntry') {
      if (!element.isEnd) {
        currentTrack = {};
        continue;
      }
      if (
        currentTrack
        && Number.isSafeInteger(currentTrack.number)
        && currentTrack.number > 0
        && currentTrack.type === 1
        && supportedWebmVideoCodecs.has(currentTrack.codec)
        && Number.isSafeInteger(currentTrack.width)
        && currentTrack.width > 0
        && Number.isSafeInteger(currentTrack.height)
        && currentTrack.height > 0
        && currentTrack.width <= Math.floor(maximumAvatarPixels / currentTrack.height)
      ) {
        trackNumbers.add(currentTrack.number);
      }
      currentTrack = null;
      continue;
    }
    if (!currentTrack) {
      continue;
    }
    if (element.name === 'TrackNumber') {
      currentTrack.number = element.value;
    } else if (element.name === 'TrackType') {
      currentTrack.type = element.value;
    } else if (element.name === 'CodecID') {
      currentTrack.codec = element.value;
    } else if (element.name === 'PixelWidth') {
      currentTrack.width = element.value;
    } else if (element.name === 'PixelHeight') {
      currentTrack.height = element.value;
    }
  }
  return trackNumbers;
}

function hasVideoFrame(elements, videoTrackNumbers) {
  let clusterDepth = 0;
  for (const element of elements) {
    if (element.type === 'm' && element.name === 'Cluster') {
      clusterDepth += element.isEnd ? -1 : 1;
      continue;
    }
    if (
      clusterDepth < 1
      || element.type !== 'b'
      || (element.name !== 'Block' && element.name !== 'SimpleBlock')
    ) {
      continue;
    }
    try {
      const block = tools.readBlock(element.data);
      if (
        videoTrackNumbers.has(block.trackNumber)
        && block.frames.some((frame) => frame.length > 0)
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function isValidWebm(data) {
  try {
    const elements = new Decoder().decode(data);
    const videoTrackNumbers = collectVideoTrackNumbers(elements);
    return elements.some((element) => element.name === 'DocType' && element.value === 'webm')
      && hasCompletedMaster(elements, 'Segment')
      && hasCompletedMaster(elements, 'Tracks')
      && hasCompletedMaster(elements, 'Cluster')
      && videoTrackNumbers.size > 0
      && hasVideoFrame(elements, videoTrackNumbers);
  } catch {
    return false;
  }
}

export function createAvatarProcessor({ maximumBytes = maximumAvatarBytes } = {}) {
  const byteLimit = Math.min(maximumAvatarBytes, maximumBytes);

  return {
    async validate(data) {
      if (!Buffer.isBuffer(data) || data.length === 0) {
        throw new AvatarError('invalid_avatar', 400);
      }
      if (data.length > byteLimit) {
        throw new AvatarError('avatar_too_large', 413);
      }

      const detected = await fileTypeFromBuffer(data);
      if (!detected || !allowedMediaTypes.has(detected.mime)) {
        throw new AvatarError('unsupported_avatar_type', 415);
      }

      if (detected.mime.startsWith('image/')) {
        try {
          const image = sharp(data, {
            animated: true,
            failOn: 'warning',
            limitInputPixels: maximumAvatarPixels,
          });
          const metadata = await image.metadata();
          if (!metadata.width || !metadata.height) {
            throw new Error('Image dimensions are required');
          }
          await image.stats();
        } catch {
          throw new AvatarError('invalid_avatar', 400);
        }
      } else if (!isValidWebm(data)) {
        throw new AvatarError('invalid_avatar', 400);
      }

      return { contentType: detected.mime, data };
    },
  };
}