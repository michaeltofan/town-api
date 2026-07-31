import { describe, expect, it } from 'vitest';
import {
  buildDiscussionMediaObjectKey,
  discussionMediaKindForContentType,
  isAllowedDiscussionMediaContentType,
  matchesDiscussionMediaMagic,
  maxBytesForDiscussionMediaKind,
} from '../src/membership/discussion-media-policy.js';

describe('discussion-media-policy', () => {
  it('classifies allowed content types and size caps', () => {
    expect(isAllowedDiscussionMediaContentType('image/jpeg')).toBe(true);
    expect(isAllowedDiscussionMediaContentType('video/mp4')).toBe(true);
    expect(isAllowedDiscussionMediaContentType('image/gif')).toBe(false);
    expect(discussionMediaKindForContentType('image/png')).toBe('image');
    expect(discussionMediaKindForContentType('video/mp4')).toBe('video');
    expect(maxBytesForDiscussionMediaKind('image')).toBe(5 * 1024 * 1024);
    expect(maxBytesForDiscussionMediaKind('video')).toBe(32 * 1024 * 1024);
  });

  it('checks magic bytes and builds private object keys', () => {
    expect(matchesDiscussionMediaMagic('image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))).toBe(
      true,
    );
    expect(matchesDiscussionMediaMagic('image/jpeg', Buffer.from('nope'))).toBe(false);
    expect(
      matchesDiscussionMediaMagic(
        'image/png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(true);
    expect(
      matchesDiscussionMediaMagic(
        'video/mp4',
        Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
      ),
    ).toBe(true);

    expect(
      buildDiscussionMediaObjectKey({
        signalId: 'sig',
        uploadId: 'up',
        kind: 'image',
        contentType: 'image/webp',
      }),
    ).toBe('discussion-contributions/sig/up.webp');
  });
});
