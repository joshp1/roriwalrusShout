import { fileTypeFromBuffer } from 'file-type';
import { parseBuffer } from 'music-metadata';
import sharp from 'sharp';
import { isValidWebm } from './avatar.js';

export const maximumAttachmentBytes = 10 * 1024 * 1024;
export const maximumAttachmentsPerPost = 4;
export const defaultAttachmentAccountQuotaBytes = 100 * 1024 * 1024;
export const maximumArtImageBytes = 2 * 1024 * 1024;
export const maximumArtImageDimension = 1920;

const maximumAttachmentPixels = 40_000_000;
const allowedImageTypes = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const allowedAudioTypes = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav']);
const artSubforums = new Set(['art-2d', 'art-3d']);

export class AttachmentError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function validateImage(data) {
  try {
    const image = sharp(data, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: maximumAttachmentPixels,
    });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Image dimensions are required');
    }
    await image.stats();
  } catch {
    throw new AttachmentError('invalid_attachment', 400);
  }
}

async function validateAudio(data, contentType, parseAudio) {
  try {
    const metadata = await parseAudio(data, { mimeType: contentType, size: data.length }, {
      duration: true,
      skipCovers: true,
    });
    if (
      !metadata.format.container
      || !metadata.format.codec
      || !Number.isFinite(metadata.format.numberOfChannels)
      || metadata.format.numberOfChannels < 1
      || !Number.isFinite(metadata.format.sampleRate)
      || metadata.format.sampleRate < 1
    ) {
      throw new Error('Audio stream metadata is required');
    }
  } catch {
    throw new AttachmentError('invalid_attachment', 400);
  }
}

async function processArtImage(data) {
  for (const [width, quality] of [
    [maximumArtImageDimension, 80],
    [maximumArtImageDimension, 65],
    [1600, 65],
    [1280, 60],
  ]) {
    const output = await sharp(data, {
      failOn: 'warning',
      limitInputPixels: maximumAttachmentPixels,
    }).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 }).toBuffer();
    if (output.length <= maximumArtImageBytes) {
      return { contentType: 'image/webp', data: output };
    }
  }
  throw new AttachmentError('art_image_too_large', 413);
}

export function createAttachmentProcessor({
  detectFileType = fileTypeFromBuffer,
  maximumBytes = maximumAttachmentBytes,
  parseAudio = parseBuffer,
} = {}) {
  const byteLimit = Math.min(maximumAttachmentBytes, maximumBytes);
  return {
    async validate(data, { subforumKey } = {}) {
      if (!Buffer.isBuffer(data) || data.length === 0) {
        throw new AttachmentError('invalid_attachment', 400);
      }
      if (data.length > byteLimit) {
        throw new AttachmentError('attachment_too_large', 413);
      }
      const detected = await detectFileType(data);
      if (!detected) {
        throw new AttachmentError('unsupported_attachment_type', 415);
      }
      if (subforumKey === 'stories') {
        throw new AttachmentError('attachments_not_allowed', 400);
      }
      if (artSubforums.has(subforumKey)) {
        if (!allowedImageTypes.has(detected.mime) || detected.mime === 'image/gif') {
          throw new AttachmentError('art_images_only', 415);
        }
        await validateImage(data);
        try {
          return await processArtImage(data);
        } catch (error) {
          if (error instanceof AttachmentError) throw error;
          throw new AttachmentError('invalid_attachment', 400);
        }
      }
      if (allowedImageTypes.has(detected.mime)) {
        await validateImage(data);
      } else if (allowedAudioTypes.has(detected.mime)) {
        await validateAudio(data, detected.mime, parseAudio);
      } else if (detected.mime === 'video/webm') {
        if (!isValidWebm(data)) {
          throw new AttachmentError('invalid_attachment', 400);
        }
      } else {
        throw new AttachmentError('unsupported_attachment_type', 415);
      }
      return { contentType: detected.mime, data };
    },
  };
}
