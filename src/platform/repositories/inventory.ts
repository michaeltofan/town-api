import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  accountEmails,
  accounts,
  actors,
  communities,
  emailChallenges,
  membershipEntitlements,
  signalDiscussionContributions,
  signalDiscussionSessions,
  signals,
  signalSubmissions,
  stripeCheckoutAttempts,
  stripeCustomerLinks,
} from '../../db/schema.js';

type Db = Database['db'];

export type PlatformAccountListRow = {
  accountId: string;
  status: string;
  isOwner: boolean;
  email: string | null;
  communitySlug: string | null;
  membershipStatus: string | null;
  suspendedAt: string | null;
  createdAt: string;
};

export async function listPlatformAccounts(
  db: Db,
  input: {
    limit: number;
    status?: string;
    email?: string;
    q?: string;
  },
): Promise<PlatformAccountListRow[]> {
  const filters: SQL[] = [];
  if (input.status) {
    filters.push(eq(accounts.status, input.status));
  }
  if (input.email) {
    filters.push(eq(accountEmails.emailNormalized, input.email));
  }
  if (input.q) {
    const pattern = `%${input.q}%`;
    const search = or(
      ilike(accountEmails.emailNormalized, pattern),
      ilike(accountEmails.emailOriginal, pattern),
      sql`${accounts.id}::text ilike ${pattern}`,
    );
    if (search) {
      filters.push(search);
    }
  }

  const base = db
    .select({
      accountId: accounts.id,
      status: accounts.status,
      isOwner: accounts.isOwner,
      email: accountEmails.emailOriginal,
      communitySlug: communities.slug,
      membershipStatus: membershipEntitlements.status,
      suspendedAt: accounts.suspendedAt,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .leftJoin(
      accountEmails,
      and(
        eq(accountEmails.accountId, accounts.id),
        eq(accountEmails.isPrimary, true),
        isNull(accountEmails.revokedAt),
      ),
    )
    .leftJoin(actors, and(eq(actors.accountId, accounts.id), eq(actors.kind, 'civic')))
    .leftJoin(communities, eq(communities.id, actors.communityId))
    .leftJoin(membershipEntitlements, eq(membershipEntitlements.accountId, accounts.id));

  const filtered = filters.length === 0 ? base : base.where(and(...filters));

  return filtered.orderBy(desc(accounts.createdAt)).limit(input.limit);
}

export async function getPlatformAccountDetail(db: Db, accountId: string) {
  const detail = await db
    .select({
      accountId: accounts.id,
      status: accounts.status,
      isOwner: accounts.isOwner,
      email: accountEmails.emailOriginal,
      communitySlug: communities.slug,
      membershipStatus: membershipEntitlements.status,
      suspendedAt: accounts.suspendedAt,
      createdAt: accounts.createdAt,
      accountReadyAt: accounts.accountReadyAt,
      closedAt: accounts.closedAt,
      updatedAt: accounts.updatedAt,
    })
    .from(accounts)
    .leftJoin(
      accountEmails,
      and(
        eq(accountEmails.accountId, accounts.id),
        eq(accountEmails.isPrimary, true),
        isNull(accountEmails.revokedAt),
      ),
    )
    .leftJoin(actors, and(eq(actors.accountId, accounts.id), eq(actors.kind, 'civic')))
    .leftJoin(communities, eq(communities.id, actors.communityId))
    .leftJoin(membershipEntitlements, eq(membershipEntitlements.accountId, accounts.id))
    .where(eq(accounts.id, accountId))
    .limit(1);
  return detail[0] ?? null;
}

export async function listPlatformCommunities(db: Db) {
  const actorCounts = db
    .select({
      communityId: actors.communityId,
      boundAccounts: count(actors.id).as('bound_accounts'),
    })
    .from(actors)
    .where(and(eq(actors.kind, 'civic'), isNotNull(actors.communityId)))
    .groupBy(actors.communityId)
    .as('actor_counts');

  return db
    .select({
      id: communities.id,
      slug: communities.slug,
      displayName: communities.displayName,
      countryCode: communities.countryCode,
      cityName: communities.cityName,
      status: communities.status,
      boundAccounts: sql<number>`coalesce(${actorCounts.boundAccounts}, 0)`.mapWith(Number),
    })
    .from(communities)
    .leftJoin(actorCounts, eq(actorCounts.communityId, communities.id))
    .orderBy(asc(communities.position));
}

export async function listPlatformMemberships(db: Db, input: { limit: number; status?: string }) {
  const filters: SQL[] = [];
  if (input.status) {
    filters.push(eq(membershipEntitlements.status, input.status));
  }
  const base = db
    .select({
      accountId: membershipEntitlements.accountId,
      status: membershipEntitlements.status,
      source: membershipEntitlements.source,
      accessUntil: membershipEntitlements.accessUntil,
      activatedAt: membershipEntitlements.activatedAt,
      expiredAt: membershipEntitlements.expiredAt,
      updatedAt: membershipEntitlements.updatedAt,
      email: accountEmails.emailOriginal,
    })
    .from(membershipEntitlements)
    .leftJoin(
      accountEmails,
      and(
        eq(accountEmails.accountId, membershipEntitlements.accountId),
        eq(accountEmails.isPrimary, true),
        isNull(accountEmails.revokedAt),
      ),
    );
  const filtered = filters.length === 0 ? base : base.where(and(...filters));
  return filtered.orderBy(desc(membershipEntitlements.updatedAt)).limit(input.limit);
}

export async function listPlatformSignals(db: Db, input: { limit: number; hiddenOnly?: boolean }) {
  const filters = [eq(signals.publicationStatus, 'published')];
  if (input.hiddenOnly) {
    filters.push(isNotNull(signals.hiddenAt));
  }
  return db
    .select({
      id: signals.id,
      slug: signals.slug,
      headline: signals.headline,
      communitySlug: communities.slug,
      authorDisplayName: signals.authorDisplayName,
      authorAccountId: signals.authorAccountId,
      hidden: sql<boolean>`${signals.hiddenAt} is not null`.mapWith(Boolean),
      hiddenAt: signals.hiddenAt,
      hiddenReason: signals.hiddenReason,
      publishedAt: signals.publishedAt,
    })
    .from(signals)
    .innerJoin(communities, eq(communities.id, signals.communityId))
    .where(and(...filters))
    .orderBy(desc(signals.publishedAt))
    .limit(input.limit);
}

export async function listPlatformSubmissions(db: Db, input: { limit: number }) {
  return db
    .select({
      id: signalSubmissions.id,
      accountId: signalSubmissions.accountId,
      communitySlug: communities.slug,
      headline: signalSubmissions.headline,
      status: signalSubmissions.status,
      createdAt: signalSubmissions.createdAt,
    })
    .from(signalSubmissions)
    .innerJoin(communities, eq(communities.id, signalSubmissions.communityId))
    .orderBy(desc(signalSubmissions.createdAt))
    .limit(input.limit);
}

export async function listPlatformDiscussions(db: Db, input: { limit: number }) {
  return db
    .select({
      contributionId: signalDiscussionContributions.id,
      sessionId: signalDiscussionContributions.sessionId,
      signalId: signalDiscussionSessions.signalId,
      signalSlug: signals.slug,
      communitySlug: communities.slug,
      intent: signalDiscussionContributions.intent,
      body: signalDiscussionContributions.text,
      accountId: actors.accountId,
      createdAt: signalDiscussionContributions.createdAt,
    })
    .from(signalDiscussionContributions)
    .innerJoin(
      signalDiscussionSessions,
      eq(signalDiscussionSessions.id, signalDiscussionContributions.sessionId),
    )
    .innerJoin(signals, eq(signals.id, signalDiscussionSessions.signalId))
    .innerJoin(communities, eq(communities.id, signals.communityId))
    .innerJoin(actors, eq(actors.id, signalDiscussionContributions.actorId))
    .where(isNotNull(actors.accountId))
    .orderBy(desc(signalDiscussionContributions.createdAt))
    .limit(input.limit);
}

export async function getPlatformAccountEmails(db: Db, accountId: string) {
  const emails = await db
    .select({
      id: accountEmails.id,
      emailOriginal: accountEmails.emailOriginal,
      emailNormalized: accountEmails.emailNormalized,
      isPrimary: accountEmails.isPrimary,
      verifiedAt: accountEmails.verifiedAt,
      revokedAt: accountEmails.revokedAt,
      createdAt: accountEmails.createdAt,
    })
    .from(accountEmails)
    .where(eq(accountEmails.accountId, accountId))
    .orderBy(desc(accountEmails.createdAt));

  const challenges = await db
    .select({
      id: emailChallenges.id,
      emailNormalized: emailChallenges.emailNormalized,
      purpose: emailChallenges.purpose,
      createdAt: emailChallenges.createdAt,
      expiresAt: emailChallenges.expiresAt,
      consumedAt: emailChallenges.consumedAt,
      revokedAt: emailChallenges.revokedAt,
      attemptCount: emailChallenges.attemptCount,
    })
    .from(emailChallenges)
    .where(eq(emailChallenges.accountId, accountId))
    .orderBy(desc(emailChallenges.createdAt))
    .limit(50);

  return { emails, challenges };
}

export async function getPlatformAccountPayments(db: Db, accountId: string) {
  const entitlement = await db
    .select({
      status: membershipEntitlements.status,
      source: membershipEntitlements.source,
      accessUntil: membershipEntitlements.accessUntil,
      cancelAtPeriodEnd: membershipEntitlements.cancelAtPeriodEnd,
      activatedAt: membershipEntitlements.activatedAt,
      cancellationRequestedAt: membershipEntitlements.cancellationRequestedAt,
      expiredAt: membershipEntitlements.expiredAt,
      version: membershipEntitlements.version,
      updatedAt: membershipEntitlements.updatedAt,
    })
    .from(membershipEntitlements)
    .where(eq(membershipEntitlements.accountId, accountId))
    .limit(1);

  const customerLink = await db
    .select({
      billingReference: stripeCustomerLinks.billingReference,
      createdAt: stripeCustomerLinks.createdAt,
      updatedAt: stripeCustomerLinks.updatedAt,
    })
    .from(stripeCustomerLinks)
    .where(eq(stripeCustomerLinks.accountId, accountId))
    .limit(1);

  const checkoutAttempts = await db
    .select({
      id: stripeCheckoutAttempts.id,
      status: stripeCheckoutAttempts.status,
      hasStripeSession:
        sql<boolean>`${stripeCheckoutAttempts.stripeCheckoutSessionId} is not null`.mapWith(
          Boolean,
        ),
      createdAt: stripeCheckoutAttempts.createdAt,
      expiresAt: stripeCheckoutAttempts.expiresAt,
      completedAt: stripeCheckoutAttempts.completedAt,
    })
    .from(stripeCheckoutAttempts)
    .where(eq(stripeCheckoutAttempts.accountId, accountId))
    .orderBy(desc(stripeCheckoutAttempts.createdAt))
    .limit(25);

  return {
    entitlement: entitlement[0] ?? null,
    stripeCustomer: customerLink[0]
      ? { linked: true as const, ...customerLink[0] }
      : { linked: false as const },
    checkoutAttempts,
  };
}

export async function getPlatformStatusCounts(db: Db) {
  const [accountStats] = await db
    .select({
      total: count(accounts.id),
      active: sql<number>`count(*) filter (where ${accounts.status} = 'active')`.mapWith(Number),
      suspended: sql<number>`count(*) filter (where ${accounts.status} = 'suspended')`.mapWith(
        Number,
      ),
      pending: sql<number>`count(*) filter (where ${accounts.status} like 'pending_%')`.mapWith(
        Number,
      ),
    })
    .from(accounts);

  const [membershipStats] = await db
    .select({
      total: count(membershipEntitlements.id),
      active:
        sql<number>`count(*) filter (where ${membershipEntitlements.status} = 'active')`.mapWith(
          Number,
        ),
      suspended:
        sql<number>`count(*) filter (where ${membershipEntitlements.status} = 'suspended')`.mapWith(
          Number,
        ),
      expired:
        sql<number>`count(*) filter (where ${membershipEntitlements.status} = 'expired')`.mapWith(
          Number,
        ),
    })
    .from(membershipEntitlements);

  const [signalStats] = await db
    .select({
      published: count(signals.id),
      hidden: sql<number>`count(*) filter (where ${signals.hiddenAt} is not null)`.mapWith(Number),
    })
    .from(signals)
    .where(eq(signals.publicationStatus, 'published'));

  const [submissionStats] = await db
    .select({ pendingReview: count(signalSubmissions.id) })
    .from(signalSubmissions);

  const [communityStats] = await db.select({ total: count(communities.id) }).from(communities);

  return {
    accounts: {
      total: accountStats?.total ?? 0,
      active: accountStats?.active ?? 0,
      suspended: accountStats?.suspended ?? 0,
      pending: accountStats?.pending ?? 0,
    },
    memberships: {
      total: membershipStats?.total ?? 0,
      active: membershipStats?.active ?? 0,
      suspended: membershipStats?.suspended ?? 0,
      expired: membershipStats?.expired ?? 0,
    },
    signals: {
      published: signalStats?.published ?? 0,
      hidden: signalStats?.hidden ?? 0,
    },
    submissions: {
      pendingReview: submissionStats?.pendingReview ?? 0,
    },
    communities: {
      total: communityStats?.total ?? 0,
    },
  };
}
