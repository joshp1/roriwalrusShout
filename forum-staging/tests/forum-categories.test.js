import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  createAttachmentProcessor,
  maximumArtImageBytes,
  maximumArtImageDimension,
} from '../attachment.js';
import { createForumService } from '../forum.js';

function service(repository, attachmentProcessor) {
  return createForumService({
    attachmentProcessor,
    authService: {
      getSession: async () => ({ account: { id: 'member', role: 'member' } }),
      requireCsrf: async () => {},
      requireForumPostingAllowed: async () => {},
      requireForumPostingEnabled: () => {},
      requireTopicCreationAllowed: async () => {},
    },
    repository,
  });
}

test('public categories may be listed and used for new topics', async () => {
  const calls = [];
  const api = service({
    createTopic: async (...args) => { calls.push(args); return { topic: true }; },
    listTopics: async (_accountId, subforumKey) => [{ id: subforumKey }],
  });
  for (const subforum of ['public', 'art-3d', 'art-2d', 'stories']) {
    const listed = await api.listTopics('session', { subforum });
    assert.equal(listed.subforumKey, subforum);
    await api.createTopic('session', 'csrf', { subforum, title: 'A topic', body: 'Body' });
  }
  assert.deepEqual(calls.map((call) => call[1]), ['public', 'art-3d', 'art-2d', 'stories']);
});

test('story posts allow 250,000 characters while other categories retain 10,000', async () => {
  const body = 'x'.repeat(200_000);
  const repository = {
    createPost: async () => ({ id: '1' }),
    getTopicSubforumKey: async () => 'stories',
  };
  await service(repository).createPost('session', 'csrf', '1', { body });
  repository.getTopicSubforumKey = async () => 'public';
  await assert.rejects(
    service(repository).createPost('session', 'csrf', '1', { body }),
    { code: 'invalid_post_body' },
  );
  repository.getTopicSubforumKey = async () => 'stories';
  await assert.rejects(
    service(repository).createPost('session', 'csrf', '1', { body: 'x'.repeat(250_001) }),
    { code: 'invalid_post_body' },
  );
});

test('stories reject attachments before reading the uploaded file', async () => {
  let read = false;
  const api = service({
    authorizePostAttachment: async () => ({ status: 'ok', subforumKey: 'stories' }),
  }, createAttachmentProcessor());
  await assert.rejects(api.createPostAttachment('session', 'csrf', '1', {
    data: async () => { read = true; return Buffer.from('unused'); },
    name: 'image.jpg',
  }), { code: 'attachments_not_allowed' });
  assert.equal(read, false);
});

test('art images are resized and converted to a bounded WebP', async () => {
  const source = await sharp({
    create: { width: 3000, height: 2400, channels: 3, background: '#d34f42' },
  }).jpeg().toBuffer();
  const processed = await createAttachmentProcessor().validate(source, { subforumKey: 'art-2d' });
  const metadata = await sharp(processed.data).metadata();
  assert.equal(processed.contentType, 'image/webp');
  assert.ok(processed.data.length <= maximumArtImageBytes);
  assert.ok(Math.max(metadata.width, metadata.height) <= maximumArtImageDimension);
});

test('art categories reject non-image attachments', async () => {
  const processor = createAttachmentProcessor({
    detectFileType: async () => ({ mime: 'audio/mpeg' }),
  });
  await assert.rejects(
    processor.validate(Buffer.from('audio'), { subforumKey: 'art-3d' }),
    { code: 'art_images_only' },
  );
});
