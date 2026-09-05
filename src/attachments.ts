import type { AcpContentBlock } from './protocol/types';
import { t } from './i18n';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 4;

export type ImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  size: number;
};

export type ClassifiedAttachment = ImageAttachment & { error: string | null };

/** Validation is positional: the fifth attachment remains visible but is never sent. */
export function classifyAttachments(items: ImageAttachment[]): ClassifiedAttachment[] {
  return items.map((item, index) => ({
    ...item,
    error:
      item.size > MAX_IMAGE_BYTES
        ? t('attach.oversize')
        : index >= MAX_PROMPT_IMAGES
          ? t('attach.tooMany', { n: MAX_PROMPT_IMAGES })
          : null,
  }));
}

/** Canonical prompt ordering: sendable images first, then trimmed text when present. */
export function buildPromptContent(
  attachments: ImageAttachment[],
  text: string,
): AcpContentBlock[] {
  const content: AcpContentBlock[] = classifyAttachments(attachments)
    .filter((item) => item.error === null)
    .map(({ data, mimeType }) => ({ type: 'image', data, mimeType }));
  const trimmed = text.trim();
  if (trimmed) content.push({ type: 'text', text: trimmed });
  return content;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Reads bytes without transcoding; MIME type and base64 payload go to ACP unchanged. */
export async function fileToAttachment(file: File): Promise<ImageAttachment> {
  if (!file.type.startsWith('image/')) {
    throw new Error(t('attach.notImage', { name: file.name }));
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    id: globalThis.crypto.randomUUID(),
    name: file.name || t('attach.pastedName'),
    mimeType: file.type,
    data: bytesToBase64(bytes),
    size: file.size,
  };
}
