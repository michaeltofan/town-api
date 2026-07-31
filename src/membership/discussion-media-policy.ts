export const DISCUSSION_MEDIA_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
] as const;

export type DiscussionMediaContentType = (typeof DISCUSSION_MEDIA_CONTENT_TYPES)[number];
export type DiscussionMediaKind = 'image' | 'video';

export const MAX_DISCUSSION_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DISCUSSION_VIDEO_BYTES = 32 * 1024 * 1024;
export const MAX_DISCUSSION_MEDIA_BYTES = MAX_DISCUSSION_VIDEO_BYTES;
export const DISCUSSION_MEDIA_UPLOAD_TTL_MS = 60 * 60 * 1000;

export function discussionMediaKindForContentType(contentType: string): DiscussionMediaKind | null {
  if (contentType === 'image/jpeg' || contentType === 'image/png' || contentType === 'image/webp') {
    return 'image';
  }
  if (contentType === 'video/mp4') {
    return 'video';
  }
  return null;
}

export function maxBytesForDiscussionMediaKind(kind: DiscussionMediaKind): number {
  return kind === 'video' ? MAX_DISCUSSION_VIDEO_BYTES : MAX_DISCUSSION_IMAGE_BYTES;
}

export function isAllowedDiscussionMediaContentType(
  contentType: string,
): contentType is DiscussionMediaContentType {
  return (DISCUSSION_MEDIA_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/**
 * Lightweight magic-byte checks. Rejects obvious content-type spoofing.
 * Not a full media parser — fail closed on mismatch.
 */
export function matchesDiscussionMediaMagic(
  contentType: DiscussionMediaContentType,
  body: Buffer,
): boolean {
  if (contentType === 'image/jpeg') {
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return (
      body.length >= 8 &&
      body[0] === 0x89 &&
      body[1] === 0x50 &&
      body[2] === 0x4e &&
      body[3] === 0x47 &&
      body[4] === 0x0d &&
      body[5] === 0x0a &&
      body[6] === 0x1a &&
      body[7] === 0x0a
    );
  }
  if (contentType === 'image/webp') {
    return (
      body.length >= 12 &&
      body.subarray(0, 4).toString('ascii') === 'RIFF' &&
      body.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  if (contentType === 'video/mp4') {
    if (body.length < 12) return false;
    return body.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

export function buildDiscussionMediaObjectKey(input: {
  signalId: string;
  uploadId: string;
  kind: DiscussionMediaKind;
  contentType: DiscussionMediaContentType;
}): string {
  const ext =
    input.contentType === 'image/jpeg'
      ? 'jpg'
      : input.contentType === 'image/png'
        ? 'png'
        : input.contentType === 'image/webp'
          ? 'webp'
          : 'mp4';
  return `discussion-contributions/${input.signalId}/${input.uploadId}.${ext}`;
}
