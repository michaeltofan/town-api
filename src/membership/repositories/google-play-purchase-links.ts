import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  googlePlayPurchaseLinks,
  type GooglePlayPurchaseLinkRow,
} from '../../db/schema.js';

type Db = Database['db'];

export async function findGooglePlayPurchaseLinkByToken(
  db: Db,
  purchaseToken: string,
): Promise<GooglePlayPurchaseLinkRow | null> {
  const rows = await db
    .select()
    .from(googlePlayPurchaseLinks)
    .where(eq(googlePlayPurchaseLinks.purchaseToken, purchaseToken))
    .limit(1);
  return rows[0] ?? null;
}

export async function lockGooglePlayPurchaseLinkByToken(
  db: Db,
  purchaseToken: string,
): Promise<GooglePlayPurchaseLinkRow | null> {
  const locked = await db.execute<{
    id: string;
    account_id: string;
    entitlement_id: string;
    purchase_token: string;
    package_name: string;
    subscription_id: string;
    expiry_time: string;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, account_id, entitlement_id, purchase_token, package_name, subscription_id,
           expiry_time, created_at, updated_at
    FROM town.google_play_purchase_links
    WHERE purchase_token = ${purchaseToken}
    FOR UPDATE
  `);
  const row = locked.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    accountId: row.account_id,
    entitlementId: row.entitlement_id,
    purchaseToken: row.purchase_token,
    packageName: row.package_name,
    subscriptionId: row.subscription_id,
    expiryTime: row.expiry_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertGooglePlayPurchaseLink(
  db: Db,
  input: {
    id: string;
    accountId: string;
    entitlementId: string;
    purchaseToken: string;
    packageName: string;
    subscriptionId: string;
    expiryTime: string;
    createdAt: string;
    updatedAt: string;
  },
): Promise<GooglePlayPurchaseLinkRow> {
  const rows = await db
    .insert(googlePlayPurchaseLinks)
    .values({
      id: input.id,
      accountId: input.accountId,
      entitlementId: input.entitlementId,
      purchaseToken: input.purchaseToken,
      packageName: input.packageName,
      subscriptionId: input.subscriptionId,
      expiryTime: input.expiryTime,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert Google Play purchase link');
  }
  return row;
}

export function isGooglePlayPurchaseTokenUniqueViolation(error: unknown): boolean {
  const candidates: unknown[] = [
    error,
    error instanceof Error && error.cause instanceof Error ? error.cause : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const code = (candidate as { code?: unknown }).code;
    const constraint = (candidate as { constraint?: unknown }).constraint;
    if (
      code === '23505' &&
      (constraint === 'google_play_purchase_links_purchase_token_unique' ||
        (typeof constraint === 'string' && constraint.includes('purchase_token')))
    ) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /google_play_purchase_links_purchase_token_unique/i.test(message);
}
