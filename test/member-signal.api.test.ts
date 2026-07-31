import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actors, signalMediaUploads, signals } from '../src/db/schema.js';
import { createInMemoryObjectStorageAdapter } from '../src/storage/object-storage-adapter.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('member signal publish', () => {
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

  it('publishes immediately under real name with photo — no pending_review', async () => {
    const { login, registration } = await participantSession(
      'MemberSignalPublish+setup@example.com',
    );
    const headers = { authorization: `Session ${login.sessionToken}` };

    const upload = await ctx.app.inject({
      method: 'POST',
      url: '/v1/communities/milano-it/signals/media',
      headers: {
        ...headers,
        'content-type': 'image/jpeg',
      },
      payload: JPEG_BYTES,
    });
    expect(upload.statusCode).toBe(201);
    const uploadBody = upload.json<{ data: { mediaUploadId: string } }>();

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/communities/milano-it/signals',
      headers,
      payload: {
        title: 'Marciapiede pericoloso davanti alla scuola locale',
        description:
          'Il marciapiede è spezzato da settimane e costringe bambini e anziani sulla carreggiata ogni mattina.',
        category: 'SPAZIO PUBBLICO',
        realName: 'Giulia Bianchi',
        acceptedResponsibility: true,
        mediaUploadId: uploadBody.data.mediaUploadId,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      data: {
        id: string;
        status: string;
        authorDisplayName: string;
        imageMedia: { url: string };
      };
    }>();
    expect(body.data.status).toBe('published');
    expect(body.data.authorDisplayName).toBe('Giulia Bianchi');
    expect(body.data.imageMedia.url).toBe(`/v1/signals/${body.data.id}/media`);
    expect(JSON.stringify(body)).not.toMatch(/pending_review|actorId|accountId/);

    const row = await ctx.app.database.db
      .select()
      .from(signals)
      .where(eq(signals.id, body.data.id));
    expect(row[0]?.publicationStatus).toBe('published');
    expect(row[0]?.authorAccountId).toBe(registration.accountId);
    expect(row[0]?.authorDisplayName).toBe('Giulia Bianchi');

    const mediaRows = await ctx.app.database.db
      .select()
      .from(signalMediaUploads)
      .where(eq(signalMediaUploads.id, uploadBody.data.mediaUploadId));
    expect(mediaRows[0]?.status).toBe('attached');

    const actorRows = await ctx.app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId));
    expect(actorRows[0]?.displayLabel).toBe('Giulia Bianchi');

    const media = await ctx.app.inject({
      method: 'GET',
      url: body.data.imageMedia.url,
    });
    expect(media.statusCode).toBe(200);
    expect(Buffer.from(media.rawPayload)).toEqual(JPEG_BYTES);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${body.data.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      data: {
        authorDisplayName: 'Giulia Bianchi',
        imageMedia: { url: body.data.imageMedia.url },
      },
    });
  });

  it('rejects username-style realName and missing responsibility acceptance', async () => {
    const { login } = await participantSession('MemberSignalValidation+setup@example.com');
    const headers = { authorization: `Session ${login.sessionToken}` };

    const upload = await ctx.app.inject({
      method: 'POST',
      url: '/v1/communities/milano-it/signals/media',
      headers: { ...headers, 'content-type': 'image/jpeg' },
      payload: JPEG_BYTES,
    });
    const mediaUploadId = upload.json<{ data: { mediaUploadId: string } }>().data.mediaUploadId;

    const fakeName = await ctx.app.inject({
      method: 'POST',
      url: '/v1/communities/milano-it/signals',
      headers,
      payload: {
        title: 'Un problema concreto sul marciapiede di quartiere',
        description:
          'Descrizione abbastanza lunga da superare la soglia minima richiesta dalla validazione.',
        category: 'SPAZIO PUBBLICO',
        realName: '@civicuser',
        acceptedResponsibility: true,
        mediaUploadId,
      },
    });
    expect(fakeName.statusCode).toBe(400);

    const noAccept = await ctx.app.inject({
      method: 'POST',
      url: '/v1/communities/milano-it/signals',
      headers,
      payload: {
        title: 'Un problema concreto sul marciapiede di quartiere',
        description:
          'Descrizione abbastanza lunga da superare la soglia minima richiesta dalla validazione.',
        category: 'SPAZIO PUBBLICO',
        realName: 'Marco Rossi',
        mediaUploadId,
      },
    });
    expect(noAccept.statusCode).toBe(400);
  });
});
