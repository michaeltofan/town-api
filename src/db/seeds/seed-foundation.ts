import type { Database } from '../client.js';
import { communities, signals, type CommunityRow, type SignalRow } from '../schema.js';
import {
  FOUNDATION_COMMUNITIES,
  FOUNDATION_SIGNALS,
  type CanonicalCommunity,
  type CanonicalSignal,
} from './foundation-content.js';

type Db = Database['db'];

function toCommunityInsert(row: CanonicalCommunity): CommunityRow {
  return {
    id: row.id,
    slug: row.slug,
    position: row.position,
    countryCode: row.countryCode,
    cityName: row.cityName,
    displayName: row.displayName,
    defaultLocale: row.defaultLocale,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSignalInsert(row: CanonicalSignal): SignalRow {
  return {
    id: row.id,
    communityId: row.communityId,
    slug: row.slug,
    position: row.position,
    locale: row.locale,
    category: row.category,
    area: row.area,
    headline: row.headline,
    summary: row.summary,
    description: row.description,
    whyItMatters: row.whyItMatters,
    whoIsAffected: row.whoIsAffected,
    latestUpdate: row.latestUpdate,
    statusLabel: row.statusLabel,
    statusNote: row.statusNote,
    observedLabel: row.observedLabel,
    observedOn: row.observedOn,
    observedPrecision: row.observedPrecision,
    authorDisplayName: row.authorDisplayName,
    authorActorId: null,
    authorAccountId: null,
    mediaUploadId: null,
    imageKey: row.imageKey,
    imageFocusX: row.imageFocusX,
    imageFocusY: row.imageFocusY,
    publicationStatus: row.publicationStatus,
    publishedAt: row.publishedAt,
    hiddenAt: null,
    hiddenReason: null,
    hiddenByAccountId: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Upserts the canonical foundation dataset using fixed IDs.
 * Does not truncate tables or delete unknown records.
 */
export async function seedFoundationContent(db: Db): Promise<void> {
  for (const community of FOUNDATION_COMMUNITIES) {
    const values = toCommunityInsert(community);
    await db
      .insert(communities)
      .values(values)
      .onConflictDoUpdate({
        target: communities.id,
        set: {
          slug: values.slug,
          position: values.position,
          countryCode: values.countryCode,
          cityName: values.cityName,
          displayName: values.displayName,
          defaultLocale: values.defaultLocale,
          timezone: values.timezone,
          status: values.status,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt,
        },
      });
  }

  for (const signal of FOUNDATION_SIGNALS) {
    const values = toSignalInsert(signal);
    await db
      .insert(signals)
      .values(values)
      .onConflictDoUpdate({
        target: signals.id,
        set: {
          communityId: values.communityId,
          slug: values.slug,
          position: values.position,
          locale: values.locale,
          category: values.category,
          area: values.area,
          headline: values.headline,
          summary: values.summary,
          description: values.description,
          whyItMatters: values.whyItMatters,
          whoIsAffected: values.whoIsAffected,
          latestUpdate: values.latestUpdate,
          statusLabel: values.statusLabel,
          statusNote: values.statusNote,
          observedLabel: values.observedLabel,
          observedOn: values.observedOn,
          observedPrecision: values.observedPrecision,
          authorDisplayName: values.authorDisplayName,
          imageKey: values.imageKey,
          imageFocusX: values.imageFocusX,
          imageFocusY: values.imageFocusY,
          publicationStatus: values.publicationStatus,
          publishedAt: values.publishedAt,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt,
        },
      });
  }
}
