import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AppInstance } from '../src/app.js';
import {
  FOUNDATION_COMMUNITIES,
  FOUNDATION_SIGNALS,
  FOUNDATION_SIGNAL_IDS,
  type CanonicalCommunity,
  type CanonicalSignal,
} from '../src/db/seeds/foundation-content.js';
import { createSeededTestApp } from './helpers/pg.js';

function communityBySlug(slug: string): CanonicalCommunity {
  const community = FOUNDATION_COMMUNITIES.find((row) => row.slug === slug);
  if (!community) {
    throw new Error(`Missing canonical community ${slug}`);
  }
  return community;
}

function signalBySlug(slug: string): CanonicalSignal {
  const signal = FOUNDATION_SIGNALS.find((row) => row.slug === slug);
  if (!signal) {
    throw new Error(`Missing canonical signal ${slug}`);
  }
  return signal;
}

const milano = communityBySlug('milano-it');
const munich = communityBySlug('munich-de');
const milanoSignal1 = signalBySlug('milano-signal-1');
const munichSignal1 = signalBySlug('munich-signal-1');

describe('communities and signals API', () => {
  let app: AppInstance;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createSeededTestApp());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('GET /v1/communities returns exact active community contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/communities' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);

    const body = response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      id: milano.id,
      slug: 'milano-it',
      position: 1,
      countryCode: 'IT',
      cityName: 'Milano',
      displayName: 'Milano',
      defaultLocale: 'it-IT',
      timezone: 'Europe/Rome',
    });
    expect(body.data[1]).toEqual({
      id: munich.id,
      slug: 'munich-de',
      position: 2,
      countryCode: 'DE',
      cityName: 'Munich',
      displayName: 'München',
      defaultLocale: 'de-DE',
      timezone: 'Europe/Berlin',
    });
    expect(JSON.stringify(body)).not.toMatch(/createdAt|updatedAt|"status"/);
  });

  it('GET Milano and Munich signal lists return exact ordered published cards', async () => {
    const milanoResponse = await app.inject({
      method: 'GET',
      url: '/v1/communities/milano-it/signals',
    });
    expect(milanoResponse.statusCode).toBe(200);
    const milanoBody = milanoResponse.json<{
      data: { community: Record<string, unknown>; signals: Record<string, unknown>[] };
    }>();
    expect(milanoBody.data.community).toEqual({
      id: milano.id,
      slug: 'milano-it',
      displayName: 'Milano',
      defaultLocale: 'it-IT',
    });
    expect(milanoBody.data.signals).toHaveLength(3);
    expect(milanoBody.data.signals.map((signal) => signal.slug)).toEqual([
      'milano-signal-1',
      'milano-signal-2',
      'milano-signal-3',
    ]);
    expect(milanoBody.data.signals[0]).toEqual({
      id: FOUNDATION_SIGNAL_IDS.milanoSignal1,
      slug: 'milano-signal-1',
      position: 1,
      locale: 'it-IT',
      category: milanoSignal1.category,
      area: milanoSignal1.area,
      headline: milanoSignal1.headline,
      summary: milanoSignal1.summary,
      observedLabel: milanoSignal1.observedLabel,
      imageKey: milanoSignal1.imageKey,
      imageFocus: {
        x: milanoSignal1.imageFocusX,
        y: milanoSignal1.imageFocusY,
      },
    });

    const munichResponse = await app.inject({
      method: 'GET',
      url: '/v1/communities/munich-de/signals',
    });
    expect(munichResponse.statusCode).toBe(200);
    const munichBody = munichResponse.json<{
      data: { signals: { slug: string; locale: string }[] };
    }>();
    expect(munichBody.data.signals.map((signal) => signal.slug)).toEqual([
      'munich-signal-1',
      'munich-signal-2',
      'munich-signal-3',
    ]);
    expect(munichBody.data.signals.every((signal) => signal.locale === 'de-DE')).toBe(true);
  });

  it('GET Italian and German signal detail return approved content contracts', async () => {
    const italian = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}`,
    });
    expect(italian.statusCode).toBe(200);
    expect(italian.headers['content-type']).toMatch(/^application\/json/);
    const italianBody = italian.json<{ data: Record<string, unknown> }>();
    expect(italianBody.data).toEqual({
      id: FOUNDATION_SIGNAL_IDS.milanoSignal1,
      slug: 'milano-signal-1',
      community: {
        id: milano.id,
        slug: 'milano-it',
        displayName: 'Milano',
      },
      locale: 'it-IT',
      category: milanoSignal1.category,
      area: milanoSignal1.area,
      headline: milanoSignal1.headline,
      summary: milanoSignal1.summary,
      description: milanoSignal1.description,
      whyItMatters: milanoSignal1.whyItMatters,
      whoIsAffected: milanoSignal1.whoIsAffected,
      latestUpdate: milanoSignal1.latestUpdate,
      statusLabel: milanoSignal1.statusLabel,
      statusNote: milanoSignal1.statusNote,
      observedLabel: milanoSignal1.observedLabel,
      observedOn: milanoSignal1.observedOn,
      observedPrecision: milanoSignal1.observedPrecision,
      authorDisplayName: milanoSignal1.authorDisplayName,
      imageKey: milanoSignal1.imageKey,
      imageFocus: {
        x: milanoSignal1.imageFocusX,
        y: milanoSignal1.imageFocusY,
      },
      publishedAt: milanoSignal1.publishedAt,
    });

    const german = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.munichSignal1}`,
    });
    expect(german.statusCode).toBe(200);
    const germanBody = german.json<{ data: { locale: string; headline: string } }>();
    expect(germanBody.data.locale).toBe('de-DE');
    expect(germanBody.data.headline).toBe(munichSignal1.headline);
  });

  it('returns domain 404 for missing community/signal and 400 for invalid UUID', async () => {
    const missingCommunity = await app.inject({
      method: 'GET',
      url: '/v1/communities/missing-city/signals',
    });
    expect(missingCommunity.statusCode).toBe(404);
    const missingCommunityBody = missingCommunity.json<{
      error: { code: string; message: string; requestId: string };
    }>();
    expect(missingCommunityBody.error.code).toBe('COMMUNITY_NOT_FOUND');
    expect(missingCommunityBody.error.message).toBe('The requested community was not found.');
    expect(typeof missingCommunityBody.error.requestId).toBe('string');

    const missingSignal = await app.inject({
      method: 'GET',
      url: '/v1/signals/00000000-0000-4000-8000-000000009999',
    });
    expect(missingSignal.statusCode).toBe(404);
    const missingSignalBody = missingSignal.json<{
      error: { code: string; message: string; requestId: string };
    }>();
    expect(missingSignalBody.error.code).toBe('SIGNAL_NOT_FOUND');
    expect(missingSignalBody.error.message).toBe('The requested signal was not found.');
    expect(typeof missingSignalBody.error.requestId).toBe('string');

    const invalidUuid = await app.inject({
      method: 'GET',
      url: '/v1/signals/not-a-uuid',
    });
    expect(invalidUuid.statusCode).toBe(400);
    const invalidBody = invalidUuid.json<{
      statusCode: number;
      error: string;
      message: string;
      requestId: string;
    }>();
    expect(invalidBody.statusCode).toBe(400);
    expect(typeof invalidBody.requestId).toBe('string');
    expect(Object.keys(invalidBody).sort()).toEqual([
      'error',
      'message',
      'requestId',
      'statusCode',
    ]);
  });
});
