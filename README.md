# town-api

TOWN API shared backend foundation: Fastify 5, strict TypeScript, TypeBox, PostgreSQL 18, Drizzle ORM, canonical civic content, controlled signal confirmation, Account Identity Foundation, Authentication Ceremony Data/Session Foundation, email/passkey setup, and passkey authentication sessions.

## Requirements

- Node.js **24+** (see `.nvmrc`)
- npm 11+
- PostgreSQL **18** for local migration/seed/integration testing

## Architecture

- HTTP: Fastify 5 + TypeBox request/response schemas
- Database: bounded `pg` pool + Drizzle ORM
- Migrations: versioned SQL under `drizzle/` (no `drizzle-kit push`, no startup migration)
- Seeds: explicit `db:seed:foundation` and `db:seed:controlled-actor` only (never on server startup)
- Identity fixtures: explicit test-only `identity:fixtures:load` (never on server startup)
- Ceremony fixtures: explicit test-only `auth:fixtures:load` (never on server startup)
- OpenAPI 3.1: deterministic generation into `docs/openapi.v1.json` (implemented routes only; no Swagger UI)
- Identity architecture contract: `docs/account-identity-contract.v1.json` (not live routes)
- Ceremony architecture contract: `docs/authentication-ceremony-foundation.v1.json` (not live routes)

## Canonical communities and signals

This slice seeds exactly:

| Community slug | City    | Locale  | Signals     |
| -------------- | ------- | ------- | ----------- |
| `milano-it`    | Milano  | `it-IT` | 3 published |
| `munich-de`    | München | `de-DE` | 3 published |

Signal slugs:

- `milano-signal-1` … `milano-signal-3`
- `munich-signal-1` … `munich-signal-3`

Canonical copy is taken from approved `town-public` feed/detail scenes and is not rewritten.

### Fixed UUID policy

All community, signal, and controlled-actor IDs are fixed UUIDs in seed content modules. Seed execution never calls random UUID generators or `Date.now()`.

### Seed commands

```bash
export DATABASE_URL=postgres://town:town@127.0.0.1:5432/town
npm run db:migrate
npm run db:seed:foundation
npm run db:seed:controlled-actor
```

Seed behavior:

- deterministic and idempotent controlled upserts by fixed IDs
- no truncation / no deletion of unknown records
- foundation seed yields exactly 2 communities and 6 signals
- controlled actor seed yields exactly one Milano actor and **zero** confirmation rows
- not executed by migrations or application startup

Author `authorDisplayName` values are prototype editorial metadata, not verified user accounts.

Image storage is limited to `imageKey` + focus coordinates. No binaries, base64, CDN, or absolute production URLs.

## Actors and signal confirmations

### `town.actors`

Civic actors (distinct from account identity):

- kinds: `controlled_test` | `civic`
- optional nullable `account_id` (1:1 with accounts when set)
- fixed UUID controlled actor remains `account_id = null`
- controlled actor is never converted into a real account
- `kind = controlled_test`, `status = active`, Milano community

### `town.signal_confirmations`

Persistent actor↔signal confirmation rows:

- unique `(signal_id, actor_id)`
- foreign keys to signals and actors with `ON DELETE RESTRICT`
- `confirmed_at` / `created_at` set only on first creation
- no confirmation counts, reactions, comments, GPS, device metadata, or revocation state

## Temporary controlled access (NOT real authentication)

Confirmation routes are gated by a **temporary controlled test mechanism**:

| Variable                          | Rules                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `CONTROLLED_CONFIRMATION_ENABLED` | boolean, default `false`; invalid values fail startup validation     |
| `CONTROLLED_CONFIRMATION_KEY`     | required only when enabled; never logged, returned, or committed     |
| `CONTROLLED_TEST_ACTOR_ID`        | required only when enabled; must be the seeded controlled actor UUID |

Header (exact name):

```http
X-TOWN-Control-Key: <local non-secret placeholder>
```

Rules:

- this is **not** public authentication, sessions, OAuth, passkeys, or identity verification
- clients never choose or submit an actor ID
- missing/invalid key → `401 CONTROLLED_ACCESS_REQUIRED`
- feature disabled → safe `404 Not Found` (does not advertise the mechanism)
- Fastify request logging redacts `X-TOWN-Control-Key`

## Eligibility

The seeded controlled actor belongs to Milano and may confirm only **published** signals in the same community:

- Milano published signal → eligible
- Munich published signal → `403 ACTOR_NOT_ELIGIBLE_FOR_COMMUNITY`
- missing/unpublished signal → `404 SIGNAL_NOT_FOUND`

## Confirmation endpoints

| Method | Path                                 | Behavior                                                                |
| ------ | ------------------------------------ | ----------------------------------------------------------------------- |
| `GET`  | `/v1/signals/:signalId/confirmation` | actor-specific confirmation state (`confirmed` + `confirmedAt` or null) |
| `PUT`  | `/v1/signals/:signalId/confirmation` | idempotent confirm; empty body; returns stable `confirmedAt`            |

Idempotency strategy:

- database uniqueness on `(signal_id, actor_id)`
- `INSERT ... ON CONFLICT DO NOTHING` then read the persistent row
- concurrent PUTs create exactly one row
- repeated PUTs do not change `confirmed_at` / `created_at`

Persistence after restart is proven by an integration test that closes app instance A (and its pool), opens instance B against the same PostgreSQL database, and asserts identical confirmation state.

No public confirmation counts or social mechanics are exposed.

## Account identity foundation (database + contract only)

This slice adds canonical identity tables and repository invariants. It does **not** implement live authentication, email delivery, WebAuthn ceremonies, sessions, or public account endpoints.

### Domain separation

| Concept                | Meaning in V1                                                                |
| ---------------------- | ---------------------------------------------------------------------------- |
| Account identity       | Account shell, verified email, passkeys, challenges, recovery grants, events |
| Civic actor            | Local civic identity; optionally linked 1:1 to an account                    |
| Local verification     | Out of scope                                                                 |
| Membership entitlement | Out of scope — active account does **not** imply paid membership/Stripe/GPS  |

### Account states

`pending_email` → `pending_passkey` → `active` ↔ `suspended` → `closed`

Valid transitions are repository-enforced. Active requires:

- verified primary email
- at least one active passkey
- linked civic actor

### Email model and normalization

`town.account_emails` stores original + normalized values.

Conservative normalization:

- trim whitespace
- lowercase domain only
- preserve local-part casing, dots, and plus tags
- no Gmail/provider-specific rewriting

Partial unique index enforces one active normalized email. At most one active primary email per account. Revoked emails cannot remain primary.

### Passkeys

`town.passkey_credentials` stores credential id + public key bytes only (never private keys/biometrics).

- multiple passkeys per account
- unique `credential_id`
- `sign_count >= 0`; decreasing sign count rejected
- final active passkey cannot be revoked while account is `active`

### Challenges, recovery grants, WebAuthn challenge records

Hashed-only storage:

- `town.email_challenges` (`verify_email`, `recover_account`)
- `town.webauthn_challenges` (`register`, `authenticate`, `recover_register`)
- `town.recovery_grants` — restricted recovery authorization, **not sessions**

Raw codes/tokens/challenges are never stored.

### Identity security events

Append-only `town.identity_security_events` with approved event types. Metadata is optional, bounded, and rejects sensitive keys.

### Deterministic fixtures

Test-only loader:

```bash
npm run identity:fixtures:load
```

Fixed UUIDs/timestamps/byte sequences. Never runs at application startup. Does not modify the controlled actor or confirmation history.

### Architecture contract (not live OpenAPI paths)

Future identity operations are documented in:

- `docs/account-identity-contract.v1.json`
- `npm run identity:contract:generate`
- `npm run identity:contract:check`

Live `docs/openapi.v1.json` continues to list only implemented routes.

## Authentication ceremony foundation

Slice 1 adds persistent ceremony data and session records. Slice 2 adds gated email-verification runtime for account setup. Slice 3 adds first-passkey WebAuthn registration runtime (setup-grant authorized). Slice 4 adds passkey authentication assertions, opaque web/mobile sessions, rotation, logout, logout-all, web cookies, and CSRF checks. Slice 5 adds bounded account recovery (email challenge → recovery grant → recovery passkey registration) without issuing a normal login session. These slices do **not** implement production email delivery, recovery login sessions, membership, or JWTs.

### Domain separation

| Concept                 | Meaning in V1                                                                   |
| ----------------------- | ------------------------------------------------------------------------------- |
| Account identity        | Account shell, emails, passkeys, challenges, recovery grants                    |
| Civic actor             | Local civic identity; optional 1:1 link to an account                           |
| Authentication ceremony | Setup grants, WebAuthn/email challenge records, ceremony rate-limit buckets     |
| Authenticated session   | Opaque server-side `town.account_sessions`                                      |
| Local verification      | Out of scope                                                                    |
| Membership entitlement  | Out of scope — a session does **not** imply membership, Stripe, or civic rights |

### Setup grants vs recovery grants vs sessions

| Record                  | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `town.setup_grants`     | Restricted authority after email verification and before first passkey registration |
| `town.recovery_grants`  | Restricted recovery authority; not a normal session                                 |
| `town.account_sessions` | Opaque authenticated sessions for web/mobile clients                                |

Setup grants:

- purpose: `initial_passkey_registration` only
- TTL: **15 minutes**
- stored as `token_hash` only (raw tokens never stored)
- are **not** sessions
- cannot access normal account APIs, civic actions, or membership operations
- cannot create a session without completed passkey registration
- authorize only `pending_passkey` accounts

### Server-side opaque sessions

`town.account_sessions` stores hashed session tokens only.

| Policy                          | Value          |
| ------------------------------- | -------------- |
| Idle timeout                    | **1 hour**     |
| Absolute reauthentication bound | **24 hours**   |
| Sensitive-operation freshness   | **10 minutes** |

Client types: `web` | `mobile`.

Rules:

- creation requires an **active** account with verified primary email, at least one active passkey, and a linked civic actor
- suspended/closed/pending accounts cannot receive sessions
- setup grants and recovery grants cannot create sessions
- ordinary activity may extend `idle_expires_at` only (never absolute expiry, never `authenticated_at`)
- idle expiry never exceeds absolute expiry
- rotation creates a replacement session and revokes the old token atomically (`revocation_reason = rotated`)
- revocation supports one session, all sessions, or all other sessions
- `recovery_recent_at` is distinct from `authenticated_at`

### Persistent ceremony rate-limit buckets

`town.ceremony_rate_limits` stores atomic counters for ceremony-specific abuse controls.

- subjects are **pre-hashed** only (no raw email, IP, credential id, or token storage)
- uniqueness: `(scope, subject_hash, window_started_at)`
- no Redis
- Slice 3 enforces `setup_options_grant` (5 / grant) and `setup_verification_grant` (5 failed verifies / grant)
- Slice 4 enforces passkey authentication option/assertion limits by hashed IP, anonymous client key, and credential subject
- Slice 5 enforces recovery request, email-attempt, options-grant, and verification-grant limits

### Additional identity security event types

Preserved prior types, plus Slice 3/4/5:

- `passkey_registration_failed`
- `account_activated`
- `authentication_succeeded`
- `recovery_email_verified`
- `recovery_registration_failed`

### Deterministic ceremony fixtures and contract

```bash
npm run auth:fixtures:load
npm run auth:contract:generate
npm run auth:contract:check
```

Fixtures use fixed UUIDs/timestamps/byte sequences and never run at application startup.

Architecture contract: `docs/authentication-ceremony-foundation.v1.json`.

### Email verification runtime (Slice 2)

Email verification proves control of an email address during account setup. It does **not** authenticate a session and does **not** activate an account.

| Item                   | Policy                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| Feature flag           | `EMAIL_VERIFICATION_ENABLED` (default `false`)                           |
| Hash key               | `EMAIL_VERIFICATION_HASH_KEY` (HMAC-SHA-256; min 32 chars)               |
| Rate-limit subject key | `CEREMONY_RATE_LIMIT_HASH_KEY` (min 32 chars)                            |
| Delivery mode          | `test` or `development` only                                             |
| Code                   | 6 decimal digits, crypto-secure, 10-minute TTL, max 5 attempts           |
| Resend                 | invalidates prior active `verify_email` challenges (`revoked_at`)        |
| Success transition     | `pending_email` → `pending_passkey`                                      |
| Success authority      | one restricted setup grant (`initial_passkey_registration`, 15 minutes)  |
| Anti-enumeration       | request always returns generic `202 VERIFICATION_REQUEST_ACCEPTED`       |
| Trusted proxy          | `TRUST_PROXY` default `false` (do not trust arbitrary `X-Forwarded-For`) |

Implemented routes (also in live OpenAPI when registered):

| Method | Path                                       | Behavior                                                                  |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| `POST` | `/v1/account/email-verifications`          | Accept verification request; generic response; may create pending account |
| `POST` | `/v1/account/email-verifications/complete` | Verify code; issue one-time setup grant token; generic failure shape      |

When the feature is disabled, both routes return the safe `404 Not Found` shape.

Delivery adapters never send real email. Production cannot enable this feature while only test/development adapters exist.

Rate limits (persistent `town.ceremony_rate_limits`):

- email: 3 / 15 minutes, 5 / 24 hours
- IP: 10 / 15 minutes, 50 / 24 hours
- delivery cooldown: 60 seconds per normalized email
- failed attempts: 5 / challenge; 10 email+IP / 30 minutes

### WebAuthn registration runtime (Slice 3)

First-passkey registration for accounts that already have a verified primary email, status `pending_passkey`, and a valid restricted setup grant.

| Item                     | Policy                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Dependency               | `@simplewebauthn/server` pinned exactly to **13.3.2** (no browser package; no second library)    |
| Feature flag             | `WEBAUTHN_REGISTRATION_ENABLED` (default `false`)                                                |
| RP / origin              | server-owned `WEBAUTHN_RP_ID`, `WEBAUTHN_ALLOWED_ORIGINS` (explicit list; no wildcards)          |
| RP name                  | `WEBAUTHN_RP_NAME` default `TOWN`                                                                |
| Challenge hash key       | `WEBAUTHN_CHALLENGE_HASH_KEY` (HMAC-SHA-256; min 32 chars)                                       |
| Setup-grant hash key     | `EMAIL_VERIFICATION_HASH_KEY` (same keyed hash contract as Slice 2 issuance)                     |
| Rate-limit subject key   | `CEREMONY_RATE_LIMIT_HASH_KEY`                                                                   |
| Authorization            | `Authorization: SetupGrant <opaque-token>` only                                                  |
| Discoverable credentials | required (`residentKey: required`, `requireResidentKey: true`)                                   |
| User verification        | required                                                                                         |
| Attestation              | `none`                                                                                           |
| Algorithms               | ES256 (`-7`), RS256 (`-257`)                                                                     |
| User handle              | opaque 32-byte `town.accounts.webauthn_user_handle` (unique, immutable, crypto-random)           |
| Challenge TTL            | **5 minutes**; one active `register` challenge per account; hash-only storage                    |
| Ceremony reference       | non-secret `registrationCeremonyId` locates the challenge row; setup grant remains authorization |
| Credential storage       | `town.passkey_credentials` (credential id + public key bytes; never private keys / biometrics)   |
| Activation               | atomic: credential + civic actor (`community_id` null) + link + `pending_passkey` → `active`     |
| Concurrency              | exactly one concurrent verify may succeed                                                        |
| Session issuance         | **none**                                                                                         |

Production RP/origin policy (when `NODE_ENV=production`):

- RP ID exactly `towncivic.org`
- allowed origin exactly `https://towncivic.org`
- localhost, Railway, GitHub Pages, www, API, HTTP, and wildcard origins rejected

Staging / development profiles remain isolated (`staging.towncivic.org` / `localhost`).

Implemented routes:

| Method | Path                                        | Behavior                                                                 |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| `POST` | `/v1/account/passkeys/registration/options` | Issue WebAuthn creation options; revoke prior active register challenges |
| `POST` | `/v1/account/passkeys/registration/verify`  | Verify response; persist credential; activate account; consume grant     |

Public ceremony failures use one generic error:

```json
{
  "error": {
    "code": "PASSKEY_REGISTRATION_FAILED",
    "message": "Passkey registration could not be completed."
  }
}
```

When the feature is disabled, both routes return the safe `404 Not Found` shape.

Controlled test actor `00000000-0000-4000-8000-000000000301` remains unlinked (`account_id` null). New civic actors are never assigned Milano/Munich by default.

### Passkey authentication session runtime (Slice 4)

Passkey authentication is account login for active accounts with registered passkeys. It creates opaque server-side sessions and preserves the boundary between web-cookie and mobile-header transports.

| Item                          | Policy                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Feature flag                  | `PASSKEY_AUTHENTICATION_ENABLED` (default `false`)                                      |
| Challenge hash key            | `PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY` (HMAC-SHA-256; min 32 chars)                |
| Session token hash key        | `SESSION_TOKEN_HASH_KEY` (HMAC-SHA-256; min 32 chars)                                   |
| RP / origin                   | same server-owned `WEBAUTHN_RP_ID` / `WEBAUTHN_ALLOWED_ORIGINS` policy as registration  |
| Options policy                | no `allowCredentials` enumeration; `userVerification: required`; 5-minute challenge TTL |
| Counter policy                | 0→0 accepted; increasing counters accepted; repeated/decreasing positive counters fail  |
| Backup policy                 | `backup_eligible` retained; `backed_up` is monotonic and never downgraded               |
| Web session transport         | `__Host-Http-town_session` Secure, HttpOnly, SameSite=Lax, Path=/, no Domain            |
| Mobile session transport      | `Authorization: Session <opaque-token>` only                                            |
| Mutative web-session CSRF     | allowed `Origin` or `Sec-Fetch-Site: same-origin` / `same-site`                         |
| Sensitive operation freshness | logout-all requires a fresh authentication session                                      |

Implemented routes:

| Method | Path                                  | Behavior                                                                    |
| ------ | ------------------------------------- | --------------------------------------------------------------------------- |
| `POST` | `/v1/authentication/passkeys/options` | Issue WebAuthn request options for web or mobile authentication             |
| `POST` | `/v1/authentication/passkeys/verify`  | Verify assertion; create web cookie session or return mobile session token  |
| `GET`  | `/v1/authentication/session`          | Inspect current web-cookie or mobile-header session; invalid returns false  |
| `POST` | `/v1/authentication/session/rotate`   | Atomically rotate current session token; preserves authentication freshness |
| `POST` | `/v1/authentication/logout`           | Idempotently revoke current session; clears web cookie                      |
| `POST` | `/v1/authentication/logout-all`       | Revoke all sessions for the authenticated account; requires freshness       |

Web verify/rotate responses never include the raw session token in JSON:

```json
{
  "data": {
    "status": "AUTHENTICATED"
  }
}
```

Mobile verify/rotate responses include `sessionToken` and `sessionExpiresAt` and never set a cookie. Route logs and logger redaction avoid raw tokens, cookies, and `Authorization` values.

### Account recovery runtime (Slice 5)

Bounded account recovery for **active** accounts with a verified primary email. Recovery issues a restricted recovery grant and may register an additional passkey; it does **not** create a login session.

| Item                  | Policy                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Feature flag          | `ACCOUNT_RECOVERY_ENABLED` (default `false`)                                                                |
| Code hash key         | `ACCOUNT_RECOVERY_HASH_KEY` (HMAC-SHA-256; min 32 chars; binds challenge+purpose+account+code)              |
| Grant token hash key  | `ACCOUNT_RECOVERY_TOKEN_HASH_KEY` (HMAC-SHA-256; min 32 chars)                                              |
| Delivery mode         | `ACCOUNT_RECOVERY_DELIVERY_MODE` = `test` \| `development`                                                  |
| Also required         | `CEREMONY_RATE_LIMIT_HASH_KEY`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ALLOWED_ORIGINS`, `WEBAUTHN_CHALLENGE_HASH_KEY` |
| Code policy           | 6 digits; 10-minute TTL; max 5 attempts; hash-only storage                                                  |
| Grant policy          | 15-minute TTL; `Authorization: RecoveryGrant <token>`; not a session                                        |
| Eligibility           | `status=active` with verified primary email matching the request                                            |
| Anti-enumeration      | always `202` `RECOVERY_REQUEST_ACCEPTED`; never returns challenge IDs                                       |
| Completion            | adds passkey (existing remain active); revokes all sessions; sets `recovery_completed_at`                   |
| Production constraint | cannot enable while only test/development delivery adapters exist                                           |

Implemented routes:

| Method | Path                                                 | Behavior                                                                   |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `POST` | `/v1/account/recovery`                               | Request recovery; generic accepted response                                |
| `POST` | `/v1/account/recovery/verify-email`                  | Verify code; issue one-time recovery grant                                 |
| `POST` | `/v1/account/recovery/passkeys/registration/options` | Recovery WebAuthn options (reuses user handle; excludes active passkeys)   |
| `POST` | `/v1/account/recovery/passkeys/registration/verify`  | Verify recovery registration; complete recovery without creating a session |

### Passkey management / security runtime (Slice 6)

Session-authenticated passkey inventory, security reauthentication, add/rename/revoke. Registration options/verify are **dual-mode**: active Session → add-passkey (requires freshness); otherwise SetupGrant → first registration (Slice 3).

| Item                          | Policy                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Feature gate                  | `PASSKEY_AUTHENTICATION_ENABLED` (management routes); dual-mode SetupGrant still uses registration flag |
| Freshness                     | `fresh_authenticated_at` within 10 minutes; required for add and revoke                                 |
| Reauth purpose                | `manage_passkeys_authenticate` (session-bound; UV required; 5-minute challenge)                         |
| Add purpose                   | `manage_passkeys_register` (reuses user handle; excludes active credentials)                            |
| Public ids                    | Opaque `passkey_credentials.public_id` only; never credential material                                  |
| Last-passkey protection       | Cannot revoke the final active passkey                                                                  |
| Current-credential protection | Cannot revoke `authenticated_passkey_id` of the current session                                         |

Implemented routes:

| Method   | Path                                                     | Behavior                                               |
| -------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `GET`    | `/v1/account/passkeys`                                   | Inventory of active passkeys                           |
| `POST`   | `/v1/account/security/reauthentication/passkeys/options` | Security reauthentication options                      |
| `POST`   | `/v1/account/security/reauthentication/passkeys/verify`  | Confirm freshness; rotate session token                |
| `POST`   | `/v1/account/passkeys/registration/options`              | Dual-mode: Session add-passkey or SetupGrant first key |
| `POST`   | `/v1/account/passkeys/registration/verify`               | Dual-mode verify                                       |
| `PATCH`  | `/v1/account/passkeys/:passkeyId`                        | Rename (no freshness)                                  |
| `DELETE` | `/v1/account/passkeys/:passkeyId`                        | Soft revoke (freshness required)                       |

### Explicit exclusions

Still not implemented:

- production email provider (Resend/SendGrid/SES/SMTP/etc.)
- JWTs
- recovery login / session issuance from recovery
- production recovery email delivery
- membership / Stripe / local verification
- Railway / web integration / mobile integration / deployment

## Other endpoints

| Method   | Path                                                     | Behavior                                |
| -------- | -------------------------------------------------------- | --------------------------------------- |
| `GET`    | `/health/live`                                           | `{"status":"ok"}` (no DB)               |
| `GET`    | `/health/ready`                                          | DB readiness `ready` / `not_ready`      |
| `GET`    | `/v1/communities`                                        | active communities by position          |
| `GET`    | `/v1/communities/:communitySlug/signals`                 | published signals by position           |
| `GET`    | `/v1/signals/:signalId`                                  | one published signal by UUID            |
| `POST`   | `/v1/account/email-verifications`                        | gated email verification request        |
| `POST`   | `/v1/account/email-verifications/complete`               | gated email verification completion     |
| `POST`   | `/v1/account/passkeys/registration/options`              | dual-mode WebAuthn registration options |
| `POST`   | `/v1/account/passkeys/registration/verify`               | dual-mode WebAuthn registration verify  |
| `POST`   | `/v1/authentication/passkeys/options`                    | gated passkey authentication options    |
| `POST`   | `/v1/authentication/passkeys/verify`                     | gated passkey authentication verify     |
| `GET`    | `/v1/authentication/session`                             | current authentication session state    |
| `POST`   | `/v1/authentication/session/rotate`                      | rotate current authentication session   |
| `POST`   | `/v1/authentication/logout`                              | logout current authentication session   |
| `POST`   | `/v1/authentication/logout-all`                          | logout all account sessions             |
| `GET`    | `/v1/account/passkeys`                                   | list active passkeys                    |
| `POST`   | `/v1/account/security/reauthentication/passkeys/options` | security reauthentication options       |
| `POST`   | `/v1/account/security/reauthentication/passkeys/verify`  | security reauthentication verify        |
| `PATCH`  | `/v1/account/passkeys/:passkeyId`                        | rename passkey                          |
| `DELETE` | `/v1/account/passkeys/:passkeyId`                        | revoke passkey                          |

## Local database workflow

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run db:seed:foundation
npm run db:seed:controlled-actor
npm run dev
```

Useful scripts:

| Script                               | Purpose                                          |
| ------------------------------------ | ------------------------------------------------ |
| `npm run db:generate`                | generate reviewable SQL                          |
| `npm run db:check`                   | validate migration history                       |
| `npm run db:migrate`                 | apply committed migrations                       |
| `npm run db:migrate:test`            | clean-DB migration verification                  |
| `npm run db:seed:foundation`         | upsert canonical civic content                   |
| `npm run db:seed:controlled-actor`   | upsert the single controlled test actor          |
| `npm run identity:fixtures:load`     | load deterministic identity fixtures (test-only) |
| `npm run identity:contract:generate` | write identity architecture contract             |
| `npm run identity:contract:check`    | verify committed identity contract               |
| `npm run auth:fixtures:load`         | load deterministic ceremony fixtures (test-only) |
| `npm run auth:contract:generate`     | write ceremony architecture contract             |
| `npm run auth:contract:check`        | verify committed ceremony contract               |
| `npm test`                           | unit tests (no PostgreSQL required)              |
| `npm run test:integration`           | PostgreSQL 18 integration suite                  |
| `npm run check`                      | non-destructive quality gate                     |

## CI

GitHub Actions uses Node.js 24 and a PostgreSQL 18 service container with CI-only credentials (no GitHub secrets, no Railway).

CI runs format/lint/typecheck/unit tests, migration checks, foundation + controlled-actor seeds, confirmation + identity + ceremony integration coverage, live OpenAPI check, identity + ceremony contract checks, build, and dependency audits.

## Out of scope

This slice still excludes:

- production email provider
- JWTs
- recovery login sessions / production recovery email
- public password or social login
- membership / Stripe / GPS / residency / local verification
- confirmation removal / confirmation totals / comments / moderation
- notifications / admin tooling
- Redis / queues / workers / GraphQL
- web integration / mobile integration / Railway deployment
