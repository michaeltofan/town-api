function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function serializeMediaContract(document: unknown): string {
  return `${JSON.stringify(sortValue(document), null, 2)}\n`;
}

export function generateMediaContractDocument(): unknown {
  return {
    contractVersion: '1.0.0',
    title: 'TOWN Media Foundation V1',
    description:
      'Contract for member-signal and discussion-contribution media: upload validation, private object storage, TTL-bound pending uploads, and the public/private read distinction. Fixes byte-size caps, allowed content types, TTLs, and route shapes as a deliberate contract so future changes are intentional, mirroring the identity/auth-ceremony/membership/billing foundation contracts.',
    status: 'implemented',
    implementedLiveRoutes: true,
    slice: 'media_upload_storage_and_access',
    storage: {
      provider: 'Cloudflare R2 (S3-compatible)',
      adapter: 'createObjectStorageAdapter (src/storage/object-storage-adapter.ts)',
      surface: ['putObject', 'getObject'],
      requiredConfig: [
        'OBJECT_STORAGE_ENABLED',
        'OBJECT_STORAGE_ENDPOINT',
        'OBJECT_STORAGE_BUCKET',
        'OBJECT_STORAGE_ACCESS_KEY_ID',
        'OBJECT_STORAGE_SECRET_ACCESS_KEY',
      ],
      disabledBehavior:
        'when OBJECT_STORAGE_ENABLED is false, the adapter is null and both upload routes fail with OBJECT_STORAGE_NOT_AVAILABLE (503) before any auth or participant check',
      publicBucketPolicy:
        'never a public bucket URL and never a permanent URL; every read is proxied through an authenticated (or intentionally public, for published member-signal photos) API route that streams bytes from storage',
      egressCost: 'R2 has zero egress fees, the basis for the Etapa 5 Step 3 decision below',
    },
    costDecision: {
      step: 'Etapa 5 Step 2/3',
      measuredAt: '2026-08-16',
      method:
        'real k6 requests against the capacity environment at the byte sizes the browser compression step (PR #135) actually produces, real byteSize read back from server-side structured deployment logs, not assumed',
      measuredMonthlyCostUsd: 0.07,
      assumedWave: '1,000 users (Etapa 4 capacity assumption)',
      decision:
        'signed URLs / private CDN are NOT implemented; the existing server-side proxy is sufficient at this cost and scale',
      condition:
        'this decision is conditional on the measured numbers, not an architectural default -- revisit if real traffic or cost materially exceeds the Etapa 4 assumption',
      neverImplemented: ['signed GET URLs', 'private CDN', 'public bucket serving'],
    },
    memberSignalMedia: {
      uploadRoute: 'POST /v1/communities/:communitySlug/signals/media',
      readRoute: 'GET /v1/signals/:signalId/media',
      visibility: 'public once the signal is published -- same visibility as the signal itself',
      readAuth: 'none; no session check on the read route',
      readCacheControl: 'public, max-age=300',
      allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxBytes: 5 * 1024 * 1024,
      uploadTtlMs: 60 * 60 * 1000,
      uploadAuth: 'active session with participant civic access for the target community',
      objectKeyPattern: 'member-signals/{communityId}/{uploadId}.{ext}',
      magicByteChecks: {
        'image/jpeg': 'first 3 bytes are 0xff 0xd8 0xff',
        'image/png': '8-byte PNG signature 0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a',
        'image/webp': "'RIFF' at offset 0 and 'WEBP' at offset 8",
      },
      accountUploadRateLimit: {
        window: '24h',
        limit: 5,
      },
    },
    discussionContributionMedia: {
      uploadRoute: 'POST /v1/signals/:signalId/discussion-session/media',
      readRoute: 'GET /v1/signals/:signalId/discussion-session/contributions/:contributionId/media',
      visibility: 'private -- civic discussion evidence, not published content',
      readAuth: 'active session with participant civic access for the signal community',
      readCacheControl: 'private, max-age=300',
      readResponseHeaders: [
        'Content-Type',
        'Content-Length',
        'Cache-Control',
        'X-Content-Type-Options',
      ],
      allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
      maxBytesByKind: {
        image: 5 * 1024 * 1024,
        video: 32 * 1024 * 1024,
      },
      routeBodyLimit: {
        value: 32 * 1024 * 1024,
        rationale:
          'set to the video cap for the whole route since content-type/kind is not known until after the body is parsed; an oversized image (over the 5MB image cap but under the 32MB route limit) is rejected by in-handler validation (400 VALIDATION_ERROR), while an oversized video (over 32MB) is rejected by the framework body limit before the handler runs (413 PAYLOAD_TOO_LARGE)',
      },
      uploadTtlMs: 60 * 60 * 1000,
      objectKeyPattern: 'discussion-contributions/{signalId}/{uploadId}.{ext}',
      magicByteChecks: {
        'image/jpeg': 'first 3 bytes are 0xff 0xd8 0xff',
        'image/png': '8-byte PNG signature 0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a',
        'image/webp': "'RIFF' at offset 0 and 'WEBP' at offset 8",
        'video/mp4': "ftyp box marker ('ftyp' ASCII) present near the start of the file",
      },
    },
    participantGate: {
      sharedHelper: 'requireParticipantForSignal / requireParticipantInCommunity',
      evaluatedBy: 'evaluateCivicAccess (src/membership/civic-access.ts)',
      appliesTo: [
        'POST .../signals/media',
        'POST .../discussion-session/media',
        'GET .../discussion-session/contributions/:contributionId/media',
      ],
      ordering:
        'object storage availability is checked before the session/participant gate; the participant gate runs before any contribution/upload lookup',
      denialErrorCode: 'CIVIC_PARTICIPATION_NOT_AUTHORIZED',
      denialCoversBoth: ['expired_membership', 'actor_community_mismatch'],
      deniedIdentifiersExposed:
        'none; bounded denial reason categories only, never leaked to the client',
    },
    clientSideCompression: {
      owner: 'town-public (web only; mobile is out of scope for this stage)',
      scope: ['member-signal photo publish', 'discussion testimony image attachment'],
      neverAppliesTo: 'discussion testimony video (already bounded server-side at 32MB)',
      trustBoundary:
        'a client-side convenience only; server-side magic-byte, content-type, and size validation remains the sole authority and is unchanged by compression',
    },
    negativePathCoverage: {
      spoofedContentType: [
        'test/member-signal.api.test.ts',
        'test/discussion-session.media.api.test.ts',
      ],
      oversizedPayload: [
        'test/member-signal.api.test.ts (413, over MAX_MEMBER_SIGNAL_IMAGE_BYTES)',
        'test/discussion-session.media.api.test.ts (400, image over the image cap but under the route body limit)',
        'test/discussion-session.media.api.test.ts (413, video over the route body limit)',
      ],
      expiredMembership: ['test/discussion-session.media.api.test.ts'],
      crossCommunityAccess: [
        'test/discussion-session.api.test.ts (contribution creation)',
        'test/discussion-session.media.api.test.ts (media read route)',
      ],
    },
    explicitExclusions: [
      'signed GET URLs / private CDN (conditional on cost, not implemented -- see costDecision)',
      'mobile (Flutter) media upload -- separate stage per project documentation',
      'video for member-signal photos (member-signal media is photo-only)',
      'server-side re-encoding or transcoding of uploaded media',
      'thumbnail generation',
      'malware/virus scanning of uploaded bytes',
      'moderation of media content',
      'GIF or other content types beyond the fixed allowlists above',
    ],
    testCommands: ['npm test', 'npm run test:integration', 'npm run media:contract:check'],
  };
}
