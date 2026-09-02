import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  buildPromptContent,
  classifyAttachments,
  fileToAttachment,
  type ImageAttachment,
} from './attachments';

const attachment = (id: string, size = 10): ImageAttachment => ({
  id,
  name: `${id}.png`,
  mimeType: 'image/png',
  data: id,
  size,
});

describe('image attachments', () => {
  it('marks oversized images and every attachment after the fourth as unsendable', () => {
    const items = [
      attachment('one'),
      attachment('two', MAX_IMAGE_BYTES + 1),
      attachment('three'),
      attachment('four'),
      attachment('five'),
    ];

    expect(classifyAttachments(items).map((item) => item.error)).toEqual([
      null,
      '>5MB，不会发送',
      null,
      null,
      '最多 4 张，不会发送',
    ]);
  });

  it('builds images first and trimmed text last, excluding invalid attachments', () => {
    const items = [
      attachment('one'),
      attachment('two', MAX_IMAGE_BYTES + 1),
      attachment('three'),
      attachment('four'),
      attachment('five'),
    ];

    expect(buildPromptContent(items, '  hello  ')).toEqual([
      { type: 'image', data: 'one', mimeType: 'image/png' },
      { type: 'image', data: 'three', mimeType: 'image/png' },
      { type: 'image', data: 'four', mimeType: 'image/png' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('builds a pure-image prompt', () => {
    expect(buildPromptContent([attachment('one')], '   ')).toEqual([
      { type: 'image', data: 'one', mimeType: 'image/png' },
    ]);
  });

  it('preserves the file MIME type and bytes in base64', async () => {
    const file = new File([new Uint8Array([0, 1, 2, 254, 255])], 'raw.webp', {
      type: 'image/webp',
    });

    const result = await fileToAttachment(file);

    expect(result).toMatchObject({
      name: 'raw.webp',
      mimeType: 'image/webp',
      size: 5,
      data: 'AAEC/v8=',
    });
  });
});
