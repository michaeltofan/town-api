import { CIVIC_ACTOR_DISPLAY_LABEL } from '../ceremony/passkey-registration/policy.js';

/** Photo-only allowlist for member-authored civic signals. */
export const MEMBER_SIGNAL_MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type MemberSignalMediaContentType = (typeof MEMBER_SIGNAL_MEDIA_CONTENT_TYPES)[number];

export const MAX_MEMBER_SIGNAL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MEMBER_SIGNAL_MEDIA_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const MEMBER_SIGNAL_ACCOUNT_LIMIT_24H = 5;

export const MIN_MEMBER_SIGNAL_TITLE_LENGTH = 12;
export const MAX_MEMBER_SIGNAL_TITLE_LENGTH = 160;
export const MIN_MEMBER_SIGNAL_DESCRIPTION_LENGTH = 24;
export const MAX_MEMBER_SIGNAL_DESCRIPTION_LENGTH = 2000;
export const MIN_MEMBER_SIGNAL_REAL_NAME_LENGTH = 3;
export const MAX_MEMBER_SIGNAL_REAL_NAME_LENGTH = 80;

/**
 * Categories already used by foundation civic signals.
 * Member create reuses this closed set — no free-form category invention.
 */
export const MEMBER_SIGNAL_CATEGORIES = [
  'SPAZIO PUBBLICO',
  'ILLUMINAZIONE',
  'LAVORI PUBBLICI',
  'ÖFFENTLICHER RAUM',
  'STRASSENBELEUCHTUNG',
  'ÖFFENTLICHE BAUARBEITEN',
  'MEDIU',
  'INFRASTRUCTURĂ',
  'SPAȚIU PUBLIC',
] as const;

export type MemberSignalCategory = (typeof MEMBER_SIGNAL_CATEGORIES)[number];

export function isAllowedMemberSignalCategory(category: string): category is MemberSignalCategory {
  return (MEMBER_SIGNAL_CATEGORIES as readonly string[]).includes(category);
}

export function isAllowedMemberSignalMediaContentType(
  contentType: string,
): contentType is MemberSignalMediaContentType {
  return (MEMBER_SIGNAL_MEDIA_CONTENT_TYPES as readonly string[]).includes(contentType);
}

export function matchesMemberSignalMediaMagic(
  contentType: MemberSignalMediaContentType,
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
  return (
    body.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

export function buildMemberSignalMediaObjectKey(input: {
  communityId: string;
  uploadId: string;
  contentType: MemberSignalMediaContentType;
}): string {
  const ext =
    input.contentType === 'image/jpeg' ? 'jpg' : input.contentType === 'image/png' ? 'png' : 'webp';
  return `member-signals/${input.communityId}/${input.uploadId}.${ext}`;
}

/**
 * Real civic identity for publication — not a handle/username/pseudonym.
 * Rejects the generic civic actor placeholder and @-style usernames.
 */
export function normalizeMemberSignalRealName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (
    name.length < MIN_MEMBER_SIGNAL_REAL_NAME_LENGTH ||
    name.length > MAX_MEMBER_SIGNAL_REAL_NAME_LENGTH
  ) {
    return null;
  }
  if (name === CIVIC_ACTOR_DISPLAY_LABEL) {
    return null;
  }
  if (name.startsWith('@') || /\s@/.test(name)) {
    return null;
  }
  // Require at least two name parts (given + family) — blocks single-token handles.
  if (!name.includes(' ')) {
    return null;
  }
  if (!/[\p{L}]/u.test(name)) {
    return null;
  }
  return name;
}

export function memberSignalImageKeyPlaceholder(signalId: string): string {
  return `member-signal:${signalId}`;
}

export function memberSignalMediaProxyPath(signalId: string): string {
  return `/v1/signals/${encodeURIComponent(signalId)}/media`;
}

export function buildMemberSignalSlug(title: string, signalId: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const suffix = signalId.replace(/-/g, '').slice(0, 8);
  return `${base.length > 0 ? base : 'signal'}-${suffix}`;
}

export function truncateSummary(description: string, max = 220): string {
  const trimmed = description.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
