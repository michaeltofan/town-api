import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { signalDiscussionMediaUploads } from '../src/db/schema.js';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import {
  MAX_DISCUSSION_IMAGE_BYTES,
  MAX_DISCUSSION_VIDEO_BYTES,
} from '../src/membership/discussion-media-policy.js';
import { ERROR_CODE } from '../src/schemas/error.js';
import { createInMemoryObjectStorageAdapter } from '../src/storage/object-storage-adapter.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

/** Minimal JPEG (SOI + APP0-ish marker) that passes magic-byte check. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
/** Minimal MP4 (ftyp box) that passes magic-byte check. */
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

describe('signal discussion-session media upload', () => {
  const storage = createInMemoryObjectStorageAdapter();
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;

  beforeAll(async () => {
    ctx = await createMembershipTestApp({
      localEligibilityResolver: createEligibleTestResolver(),
      objectStorageAdapter: storage,
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function participantSession(email: string) {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email,
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
    });
    return { registration, login };
  }

  it('returns 503 when object storage is unavailable', async () => {
    const offline = await createMembershipTestApp({
      localEligibilityResolver: createEligibleTestResolver(),
      objectStorageAdapter: null,
    });
    try {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: offline.app,
        delivery: offline.delivery,
        email: 'DiscussionMediaOffline+setup@example.com',
      });
      await activateTestMembership(offline.app, {
        accountId: registration.accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2030-01-01T00:00:00.000Z',
      });
      const login = await loginMobileSession({
        app: offline.app,
        material: registration.material,
      });
      const response = await offline.app.inject({
        method: 'POST',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/discussion-session/media`,
        headers: {
          authorization: `Session ${login.sessionToken}`,
          'content-type': 'image/jpeg',
        },
        payload: JPEG_BYTES,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'OBJECT_STORAGE_NOT_AVAILABLE' },
      });
    } finally {
      await offline.app.close();
      await offline.pool.end();
    }
  });

  it('uploads media to private storage, attaches on contribute, and proxies bytes', async () => {
    const { login } = await participantSession('DiscussionMediaOk+setup@example.com');
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal2;
    const headers = { authorization: `Session ${login.sessionToken}` };

    const upload = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/media`,
      headers: {
        ...headers,
        'content-type': 'image/jpeg',
      },
      payload: JPEG_BYTES,
    });
    expect(upload.statusCode).toBe(201);
    const uploadBody = upload.json<{
      data: {
        mediaUploadId: string;
        kind: string;
        contentType: string;
        byteSize: number;
        expiresAt: string;
      };
    }>();
    expect(uploadBody.data.kind).toBe('image');
    expect(uploadBody.data.contentType).toBe('image/jpeg');
    expect(uploadBody.data.byteSize).toBe(JPEG_BYTES.byteLength);
    expect(uploadBody.data.mediaUploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const pendingRows = await ctx.app.database.db
      .select()
      .from(signalDiscussionMediaUploads)
      .where(eq(signalDiscussionMediaUploads.id, uploadBody.data.mediaUploadId));
    expect(pendingRows).toHaveLength(1);
    const pending = pendingRows[0];
    expect(pending?.status).toBe('pending');
    expect(pending?.objectKey).toBeTruthy();
    if (!pending) {
      throw new Error('expected pending media upload row');
    }
    expect(storage.objects.has(pending.objectKey)).toBe(true);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/contributions`,
      headers,
      payload: {
        text: 'Photo evidence of the damaged curb near the school entrance.',
        intent: 'observation',
        mediaUploadId: uploadBody.data.mediaUploadId,
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{
      data: {
        contributions: {
          id: string;
          media: {
            kind: string;
            contentType: string;
            byteSize: number;
            url: string;
          } | null;
        }[];
      };
    }>();
    const contribution = createdBody.data.contributions[0];
    expect(contribution).toBeTruthy();
    if (!contribution?.media) {
      throw new Error('expected contribution media');
    }
    expect(contribution.media).toMatchObject({
      kind: 'image',
      contentType: 'image/jpeg',
      byteSize: JPEG_BYTES.byteLength,
    });
    expect(contribution.media.url).toBe(
      `/v1/signals/${signalId}/discussion-session/contributions/${contribution.id}/media`,
    );
    expect(JSON.stringify(createdBody)).not.toMatch(/actorId|accountId|objectKey/);

    const attached = await ctx.app.database.db
      .select()
      .from(signalDiscussionMediaUploads)
      .where(eq(signalDiscussionMediaUploads.id, uploadBody.data.mediaUploadId));
    expect(attached[0]?.status).toBe('attached');

    const media = await ctx.app.inject({
      method: 'GET',
      url: contribution.media.url,
      headers,
    });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(media.rawPayload)).toEqual(JPEG_BYTES);
  });

  it('rejects spoofed content type and unknown mediaUploadId', async () => {
    const { login } = await participantSession('DiscussionMediaBad+setup@example.com');
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const headers = { authorization: `Session ${login.sessionToken}` };

    const spoofed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/media`,
      headers: {
        ...headers,
        'content-type': 'image/jpeg',
      },
      payload: Buffer.from('not-a-jpeg'),
    });
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const badAttach = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/contributions`,
      headers,
      payload: {
        text: 'A proposal that references a missing media upload id value.',
        intent: 'proposal',
        mediaUploadId: '00000000-0000-4000-8000-00000000dead',
      },
    });
    expect(badAttach.statusCode).toBe(400);
    expect(badAttach.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects an image over the discussion image cap (under the route body limit)', async () => {
    const { login } = await participantSession('DiscussionMediaOversizedImage+setup@example.com');
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const headers = { authorization: `Session ${login.sessionToken}` };

    const oversized = Buffer.concat([
      JPEG_BYTES,
      Buffer.alloc(MAX_DISCUSSION_IMAGE_BYTES + 1 - JPEG_BYTES.byteLength),
    ]);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/media`,
      headers: { ...headers, 'content-type': 'image/jpeg' },
      payload: oversized,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects a video over the discussion video cap (route body limit)', async () => {
    const { login } = await participantSession('DiscussionMediaOversizedVideo+setup@example.com');
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const headers = { authorization: `Session ${login.sessionToken}` };

    const oversized = Buffer.concat([
      MP4_BYTES,
      Buffer.alloc(MAX_DISCUSSION_VIDEO_BYTES + 1 - MP4_BYTES.byteLength),
    ]);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/media`,
      headers: { ...headers, 'content-type': 'video/mp4' },
      payload: oversized,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: ERROR_CODE.PAYLOAD_TOO_LARGE } });
  });
});
