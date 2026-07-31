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
| `arad-ro`      | Arad    | `ro-RO` | 3 published |

Signal slugs:

- `milano-signal-1` … `milano-signal-3`
- `munich-signal-1` … `munich-signal-3`
- `arad-signal-1` … `arad-signal-3`

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
- foundation seed yields exactly 3 communities and 9 signals
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

## Signal discussion sessions

Civic contributions toward a local solution on a published signal — not chat, comments, or social threading.

| Method | Path                                                     | Behavior                                                                      |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET`  | `/v1/signals/:signalId/discussion-session`               | get-or-create session + ordered contributions                                 |
| `POST` | `/v1/signals/:signalId/discussion-session/contributions` | publish `{ text, intent }` where intent is `observation\|proposal\|next_step` |

Both routes require an active web/mobile session and `evaluateCivicAccess(...).canParticipate === true`. SetupGrant / RecoveryGrant / Bearer are rejected. Denials return `403 CIVIC_PARTICIPATION_NOT_AUTHORIZED` without leaking the reason and append `civic_participation_denied`. Response shape never exposes actor or account identifiers — only `authorDisplayName` (civic `display_label`).

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

Optional password setup may still use `pending_email` → `pending_password` → `pending_passkey` when an `initial_password_setup` grant is issued (for example via pending_password re-entry). Valid transitions are repository-enforced. Active requires:

- verified primary email
- at least one active passkey
- linked civic actor
- WebAuthn user handle

Password credentials remain optional for activation; password setup and password sign-in APIs are unchanged.

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

Slice 1 adds persistent ceremony data and session records. Slice 2 adds gated email-verification runtime for account setup. Ordinary new-account email completion hands off directly to first-passkey registration (`pending_email` → `pending_passkey` → `active`) with an `initial_passkey_registration` SetupGrant. Initial password setup remains available for `pending_password` accounts (`PASSWORD_AUTH_ENABLED`) but is not part of the ordinary public new-account journey. Slice 3 adds first-passkey WebAuthn registration runtime (setup-grant authorized). Slice 4 adds passkey authentication assertions, opaque web/mobile sessions, rotation, logout, logout-all, web cookies, and CSRF checks. Slice 5 adds bounded account recovery (email challenge → recovery grant → recovery passkey registration) without issuing a normal login session. These slices do **not** implement production email delivery, recovery login sessions, membership, or JWTs.

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

| Record                  | Role                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `town.setup_grants`     | Purpose-bound restricted authority for initial password setup or first-passkey registration |
| `town.recovery_grants`  | Restricted recovery authority; not a normal session                                         |
| `town.account_sessions` | Opaque authenticated sessions for web/mobile clients                                        |

Setup grants:

- purposes: `initial_password_setup` | `initial_passkey_registration` (purpose-bound; a grant never authorizes both)
- TTL: **15 minutes**
- stored as `token_hash` only (raw tokens never stored)
- are **not** sessions
- cannot access normal account APIs, civic actions, or membership operations
- cannot create a session
- `initial_password_setup` requires `pending_password`; `initial_passkey_registration` requires `pending_passkey`

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
- Initial password setup enforces `password_setup_grant` (5 / grant)
- Slice 4 enforces passkey authentication option/assertion limits by hashed IP, anonymous client key, and credential subject
- Slice 5 enforces recovery request, email-attempt, options-grant, and verification-grant limits

### Additional identity security event types

Preserved prior types, plus Slice 3/4/5 and initial password setup:

- `passkey_registration_failed`
- `account_activated`
- `authentication_succeeded`
- `recovery_email_verified`
- `recovery_registration_failed`
- `password_credential_created`

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

| Item                   | Policy                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Feature flag           | `EMAIL_VERIFICATION_ENABLED` (default `false`)                                                                                         |
| Hash key               | `EMAIL_VERIFICATION_HASH_KEY` (HMAC-SHA-256; min 32 chars)                                                                             |
| Rate-limit subject key | `CEREMONY_RATE_LIMIT_HASH_KEY` (min 32 chars)                                                                                          |
| Delivery mode          | `test`, `development`, or `resend`                                                                                                     |
| Code                   | 6 decimal digits, crypto-secure, 10-minute TTL, max 5 attempts                                                                         |
| Resend                 | invalidates prior active `verify_email` challenges (`revoked_at`)                                                                      |
| Success transition     | `pending_email` → `pending_passkey`                                                                                                    |
| Success authority      | one restricted setup grant (`initial_passkey_registration`, 15 minutes); `pending_password` re-entry reissues `initial_password_setup` |
| Anti-enumeration       | request always returns generic `202 VERIFICATION_REQUEST_ACCEPTED` plus a UUID `verificationId`                                        |
| Trusted proxy          | `TRUST_PROXY` default `false` (do not trust arbitrary `X-Forwarded-For`)                                                               |

Implemented routes (also in live OpenAPI when registered):

| Method | Path                                       | Behavior                                                                                        |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `POST` | `/v1/account/email-verifications`          | Accept verification request; generic response with `verificationId`; may create pending account |
| `POST` | `/v1/account/email-verifications/complete` | Verify code; issue one-time setup grant token; generic failure shape                            |

When the feature is disabled, both routes return the safe `404 Not Found` shape.

Delivery modes: in-memory `test` / `development` sinks, or `resend` (HTTPS POST to Resend). Feature remains disabled by default. Production (`NODE_ENV=production`) may enable only with `EMAIL_VERIFICATION_DELIVERY_MODE=resend` plus Resend credentials.

Rate limits (persistent `town.ceremony_rate_limits`):

- email: 3 / 15 minutes, 5 / 24 hours
- IP: 10 / 15 minutes, 50 / 24 hours
- delivery cooldown: 60 seconds per normalized email
- failed attempts: 5 / challenge; 10 email+IP / 30 minutes

### Initial password setup runtime

Sets the initial password for `pending_password` accounts (for example after pending_password re-entry). Does **not** authenticate a session and does **not** activate an account. Ordinary new-account email completion does not force this step.

| Item             | Policy                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Feature flag     | `PASSWORD_AUTH_ENABLED` (default `false`)                                                                   |
| Authorization    | `Authorization: SetupGrant <opaque-token>` with purpose `initial_password_setup`                            |
| Success          | `PASSWORD_SET`; stores Argon2id credential; `pending_password` → `pending_passkey`; hands off passkey grant |
| Session issuance | **none**                                                                                                    |
| Public error     | `PASSWORD_SETUP_FAILED`                                                                                     |
| Rate limit       | `password_setup_grant`: 5 / grant                                                                           |

Implemented route:

| Method | Path                   | Behavior                                                                                       |
| ------ | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `POST` | `/v1/account/password` | Set initial password; consume password-setup grant; issue `initial_passkey_registration` grant |

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

Session-authenticated passkey inventory, security reauthentication, add/rename/revoke. All seven management routes require an active normal session. SetupGrant and RecoveryGrant cannot authorize any Slice 6 route. Initial first-passkey registration remains on separate SetupGrant-only Slice 3 paths.

| Item                          | Policy                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Feature gate                  | `PASSKEY_AUTHENTICATION_ENABLED`                                                |
| Freshness                     | `fresh_authenticated_at` within 10 minutes; required for add and revoke         |
| Reauth purpose                | `manage_passkeys_authenticate` (session-bound; UV required; 5-minute challenge) |
| Add purpose                   | `manage_passkeys_register` (reuses user handle; excludes active credentials)    |
| Public ids                    | Opaque `passkey_credentials.public_id` only; never credential material          |
| Last-passkey protection       | Cannot revoke the final active passkey                                          |
| Current-credential protection | Cannot revoke `authenticated_passkey_id` of the current session                 |

Implemented routes:

| Method   | Path                                                     | Behavior                                  |
| -------- | -------------------------------------------------------- | ----------------------------------------- |
| `GET`    | `/v1/account/passkeys`                                   | Inventory of active passkeys              |
| `POST`   | `/v1/account/security/reauthentication/passkeys/options` | Security reauthentication options         |
| `POST`   | `/v1/account/security/reauthentication/passkeys/verify`  | Confirm freshness; rotate session token   |
| `POST`   | `/v1/account/passkeys/add/options`                       | Add-passkey options (session + freshness) |
| `POST`   | `/v1/account/passkeys/add/verify`                        | Add-passkey verify (session + freshness)  |
| `PATCH`  | `/v1/account/passkeys/:passkeyId`                        | Rename (no freshness)                     |
| `DELETE` | `/v1/account/passkeys/:passkeyId`                        | Soft revoke (freshness required)          |

Distinct from Slice 3 initial registration (`SetupGrant` only):

| Method | Path                                        | Behavior                                          |
| ------ | ------------------------------------------- | ------------------------------------------------- |
| `POST` | `/v1/account/passkeys/registration/options` | First-passkey registration options (`SetupGrant`) |
| `POST` | `/v1/account/passkeys/registration/verify`  | First-passkey registration verify (`SetupGrant`)  |

## Membership Foundation V1 — Slice 1

> **Historical slice description.** The boundaries below describe Membership
> Foundation V1 Slice 1 as originally shipped. They are retained for audit
> context. They are **not** a description of the current repository: Stripe
> Checkout, Customer Portal, and `POST /v1/billing/stripe/webhook` were added
> in Slice 2 (see below). Stripe is the sole membership payment provider for
> the current responsive-web launch. Google Play, Flutter, Apple In-App
> Purchase, and native app-store distribution are outside the current critical
> path.

Slice 1 of the membership foundation introduces the entitlement/access runtime for civic participation. Membership is a **separate foundation** from account identity and authentication: an `accounts` row is never gated by membership, and no membership boundary weakens the identity/auth contracts.

Boundaries and non-negotiables **for Slice 1 as originally shipped**:

- Zero Stripe or other payment-provider dependency in that slice. No SDK, no webhook route, no provider identifiers in any public response. Internal transitions accept a `source` label (`stripe`, `test_fixture`, `admin_backfill`), but Stripe customer or subscription IDs are never accepted from or emitted to the network. _(Superseded for the live repo by Slice 2 Stripe billing runtime.)_
- There is exactly one public membership route: `GET /v1/account/membership`. There are no public membership mutation routes and no membership webhooks in this slice. _(Google Play purchase ingress and Stripe billing routes were added in later slices; they remain distinct from this entitlement-read surface.)_
- Local participation eligibility defaults **fail-closed**: in `production` (or any non-test/non-development `NODE_ENV`), the default resolver returns `unavailable` and civic access reads never elevate to `participant`. Real local verification data plumbing is out of scope.
- The controlled test actor (`00000000-0000-4000-8000-000000000301`) is never linked to an account, never receives a session, and never appears in confirmation-history attribution. Participant confirmation always attributes to the caller's linked civic actor.
- Confirmation history is not reassigned after the participant PUT change. Pre-existing rows attributed to the controlled actor remain attributed to it; new participant PUTs write new rows attributed to the caller's civic actor.

### Entitlement model

`town.membership_entitlements` is a single row per account keyed by `account_id`:

| Column                      | Notes                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `status`                    | One of `inactive`, `active`, `cancelling`, `expired`                               |
| `access_until`              | UTC timestamp; participant access ends strictly before this (`now < access_until`) |
| `cancel_at_period_end`      | `true` only while `status = 'cancelling'`                                          |
| `source`                    | Internal label: `stripe`, `test_fixture`, or `admin_backfill`                      |
| `source_customer_id`        | Provider-scoped identifier, never surfaced in public responses                     |
| `source_subscription_id`    | Provider-scoped identifier, never surfaced in public responses                     |
| `activated_at`              | First transition into `active`                                                     |
| `cancellation_requested_at` | Non-null while `status = 'cancelling'`                                             |
| `expired_at`                | Set when transitioning to `expired`                                                |
| `version`                   | Monotonic per-account counter; increments only on `applied` transitions            |

Status meanings:

- `inactive`: no entitlement row yet, or an entitlement that has never been activated. Civic access is `read_only` (or `visitor` when no session), participation is denied.
- `active`: `now < access_until`. Participant access is possible when the actor is linked, the community matches, and local eligibility is `eligible`.
- `cancelling`: cancellation is scheduled; participant access is preserved until `access_until`.
- `expired`: `access_until` has passed. Civic access drops to `read_only`; participation is denied.

Access-until is also a stale-temporal boundary: even without an explicit `expire` transition, once `now >= access_until` the effective status returned by the API is `expired` and participation is denied.

### Civic access levels

Derived per request from session presence, account status, entitlement state, actor linkage, and local eligibility:

- `visitor` — no active session.
- `read_only` — active session but membership is not effective (missing/inactive/expired/cancelling with `access_until` passed) or actor/community/local eligibility does not permit participation.
- `participant` — active session, active/cancelling membership within `access_until`, linked civic actor whose community matches the target, and local eligibility `eligible`.

### `GET /v1/account/membership`

Session-authorized read (web cookie or `Authorization: Session <token>`). SetupGrant, RecoveryGrant, and Bearer schemes are rejected with `401 SESSION_NOT_AUTHORIZED`. Rate limited by `membership_inventory_account`. Never returns Stripe customer or subscription identifiers.

Response shape:

```json
{
  "data": {
    "membership": {
      "status": "inactive|active|cancelling|expired",
      "accessUntil": "2026-08-17T00:00:00.000Z",
      "cancelAtPeriodEnd": false
    },
    "access": {
      "level": "visitor|read_only|participant",
      "canParticipate": true,
      "localEligibility": "eligible|not_verified|expired|mismatched_community|unavailable"
    }
  }
}
```

### Participant signal confirmation

`PUT /v1/signals/:signalId/confirmation` is now session-authorized and requires civic-participation access. The controlled-key bypass is removed from the `PUT` path.

- Requires an active normal session; SetupGrant/RecoveryGrant/Bearer/control key are rejected with `SESSION_NOT_AUTHORIZED`.
- Web sessions must satisfy the same CSRF invariants as other mutative session routes.
- Access is evaluated as `evaluateCivicAccess({ session, account, entitlement, actor, communityId, localEligibility, now })`. When the derived level is not `participant`, the route returns `403 CIVIC_PARTICIPATION_NOT_AUTHORIZED` and appends an `identity_security_events.civic_participation_denied` event with a bounded `denialReason` (no PII, no provider IDs, no localEligibility keys beyond the enum).
- On success, `ensureParticipantSignalConfirmation` writes/returns the confirmation row attributed to the caller's linked civic actor — never the controlled test actor.

`GET /v1/signals/:signalId/confirmation` remains gated by `X-TOWN-Control-Key` for historical read-side testing isolation and is unaffected by this slice.

### Internal transitions and idempotency

Transitions are internal-only functions (`activateMembership`, `scheduleMembershipCancellation`, `reactivateMembership`, `expireMembership`). They are not reachable from any HTTP route. Each transition:

1. Locks or creates a `membership_source_events` row keyed by `(source, source_event_id)`.
2. Locks the account row and any existing entitlement row.
3. Validates the transition against the current state (e.g. reject `activate` on a closed account; reject `expire` before `access_until`; reject `reactivate` unless currently `cancelling`).
4. Applies the mutation and increments `version` exactly once on `applied` outcomes.
5. Appends bounded `identity_security_events` (`membership_created`, `membership_activated`, `membership_cancellation_scheduled`, `membership_reactivated`, `membership_expired`, `membership_event_replayed`, `membership_event_rejected`) — never containing provider IDs or personal data.

Outcomes are one of `applied`, `replayed`, `stale`, or `rejected`.

Source-event idempotency:

- Same `(source, source_event_id)` with an identical canonical payload hash → `replayed`, no state change, no version bump.
- Same `(source, source_event_id)` with a divergent payload hash → `rejected` with `payload_hash_mismatch`; no state change.
- Concurrent identical `activate` transitions (`Promise.all`) resolve to exactly one `applied` and the remainder `replayed`; the ledger stores one applied row and version increments once. Deadlocks are retried with jittered backoff.

Stale detection (accepted but not applied):

- `activate` whose `access_until` would reduce the current active window → `stale` (`would_reduce_access_until`).
- `activate` whose `effective_at` predates the current `updated_at` → `stale` (`older_event_overrides_newer_state`).
- `expire`/`schedule_cancellation` for a superseded state → `stale`.

### Reconciliation

`reconcileExpiredMemberships` walks `active`/`cancelling` rows whose `access_until <= now`, expiring them in a batch under `FOR UPDATE SKIP LOCKED`. It is idempotent, respects a caller-provided batch size, and never expires an entitlement whose `access_until` is in the future.

### Testing

Comprehensive PostgreSQL 18 integration and unit coverage:

```bash
npm test
npm run test:integration
npm run membership:contract:generate
npm run membership:contract:check
```

Suites include: payload-hash determinism, civic-access matrix (including temporal boundary and fail-closed local), migration invariants for the Slice 1 entitlement tables (Stripe billing tables arrive in Slice 2), transitions/idempotency/stale/concurrency/reconcile flows, `GET /v1/account/membership` response shapes and auth rejections, participant `PUT` matrix (including controlled-actor never linked, control-key rejected without session, and generic `CIVIC_PARTICIPATION_NOT_AUTHORIZED` denial), bounded audit metadata, and OpenAPI surface assertions.

### Exclusions

Explicitly out of scope for Slice 1:

- No public membership mutation routes; no public reconcile endpoint.
- No production local eligibility source (defaults fail-closed).
- No modification to identity/auth contracts' domain separation.
- No linking of the controlled test actor to an account or session.
- No reassignment of pre-existing confirmation history.

## Membership Foundation V1 — Slice 2 (Stripe Billing Integration Runtime)

Slice 2 adds the Stripe integration runtime that starts Checkout Sessions, opens
Billing Portal Sessions, and processes signature-verified Stripe webhooks at
`POST /v1/billing/stripe/webhook`. Stripe is the sole membership payment
provider for the current responsive-web launch; Google Play and Apple store
billing are outside that critical path. All membership state changes still flow
through the Slice 1 transitions (with `source='stripe'`); the billing runtime
does not add new membership statuses, does not expose Stripe identifiers in
public API responses, and never persists raw Stripe payloads, card data, or
checkout/portal URLs beyond the immediate response body.

### Stripe SDK version pinning

- SDK package: `stripe@22.3.2` (exact)
- API version: `2026-06-24.dahlia` (pinned via `STRIPE_API_VERSION`)
- The environment loader enforces `STRIPE_API_VERSION=2026-06-24.dahlia` when
  Stripe billing is enabled; other values are rejected.

### Environment

| Variable                         | Rules                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `STRIPE_BILLING_ENABLED`         | boolean; default `false`; invalid values fail startup validation             |
| `STRIPE_SECRET_KEY`              | required when enabled; must start with `sk_` and be at least 20 chars        |
| `STRIPE_WEBHOOK_SECRET`          | required when enabled; must start with `whsec_` and be at least 20 chars     |
| `STRIPE_ANNUAL_PRICE_ID`         | required when enabled; must start with `price_`                              |
| `STRIPE_PORTAL_CONFIGURATION_ID` | required when enabled; must start with `bpc_`                                |
| `STRIPE_CHECKOUT_SUCCESS_URL`    | absolute https URL when enabled; `https://example.test/...` allowed in tests |
| `STRIPE_CHECKOUT_CANCEL_URL`     | absolute https URL when enabled; `https://example.test/...` allowed in tests |
| `STRIPE_PORTAL_RETURN_URL`       | absolute https URL when enabled; `https://example.test/...` allowed in tests |
| `STRIPE_API_VERSION`             | `2026-06-24.dahlia` (exact)                                                  |
| `STRIPE_EXPECTED_LIVEMODE`       | `true` in production; `false` otherwise; validated against `NODE_ENV`        |
| `CEREMONY_RATE_LIMIT_HASH_KEY`   | required when enabled; drives `billing_*` rate-limit subject hashing         |

Environment validation errors never include secret values.

Billing routes require an active passkey-authenticated session, so
`PASSKEY_AUTHENTICATION_ENABLED=true` and its associated hash keys/cookie name
must also be configured. When `STRIPE_BILLING_ENABLED=false`, all three billing
routes return the safe `404 Not Found` shape.

### Fixed price contract

| Field          | Value          |
| -------------- | -------------- |
| Currency       | `eur`          |
| Unit amount    | `1200` (cents) |
| Interval       | `year`         |
| Interval count | `1`            |
| Quantity       | `1`            |

`assertAnnualPrice(price, expectedPriceId)` rejects any Stripe price that does
not match this contract with a bounded reason (`unknown_price_id`, `inactive`,
`currency_mismatch`, `unit_amount_mismatch`, `interval_mismatch`,
`interval_count_mismatch`, `not_recurring`).

### Tables

- `town.stripe_customer_links` — one Stripe Customer per TOWN account.
  Unique per `account_id`, `stripe_customer_id`, and `billing_reference`.
  Never exposed in public API responses.
- `town.stripe_checkout_attempts` — bounded ledger for Checkout attempts and
  Stripe idempotency keys. Statuses: `creating`, `open`, `completed`, `expired`,
  `failed`. Partial-unique on `stripe_checkout_session_id` when set. Never
  stores Checkout URLs or raw Stripe payloads.

### Routes

| Method | Path                                  | Behavior                                                                |
| ------ | ------------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/v1/billing/checkout-session`        | Create a Stripe Checkout Session for the caller (returns `checkoutUrl`) |
| `POST` | `/v1/billing/customer-portal-session` | Open a Stripe Customer Portal Session (returns `portalUrl`)             |
| `POST` | `/v1/billing/stripe/webhook`          | Signature-verified Stripe webhook (raw body Buffer parser, 1 MB limit)  |

Checkout and portal require an active web or mobile session. `SetupGrant`,
`RecoveryGrant`, and `Bearer` are rejected. Bodies are strictly empty objects
(`additionalProperties: false`). Response bodies only ever expose the Stripe
Checkout / Portal URL for the current call.

### Idempotency

- `town:create-customer:<billing-reference>` — Stripe Customer creation.
- `town:checkout:<billing-reference>:<attempt-id>` — Stripe Checkout Session
  creation. Duplicate calls with the same key surface the same Session.

### Webhook processor

Signature verification uses the official Stripe SDK (`webhooks.constructEvent`).
The webhook route registers a raw-body Buffer content type parser in an
encapsulated Fastify plugin so signature verification runs against the exact
bytes Stripe signed. Signature-mismatch requests return `400 Bad Request`
without invoking the processor.

Handled event types:

- `checkout.session.completed` — links the subscription reference to the
  entitlement without activating. Never returns URLs to the client.
- `invoice.paid` — validates the price policy against the pinned annual price,
  derives `accessUntil` from the subscription's current period end (ISO), and
  activates membership via `activateMembership(source='stripe')`.
- `customer.subscription.updated` — when `cancel_at_period_end=true` schedules
  cancellation; when `cancel_at_period_end=false` reactivates a cancelling
  membership. Unsupported changes (multi-line, price/quantity mismatch, pause,
  trial) are rejected without mutation.
- `customer.subscription.deleted` — if `now >= access_until` expires the
  entitlement; otherwise preserves access and appends an audit event.
- `invoice.payment_failed` — audit only; no entitlement mutation.

All other event types return 2xx with no state mutation. Events with
`livemode !== STRIPE_EXPECTED_LIVEMODE` or an `api_version` that does not match
the pinned value are rejected without mutation.

Transition-invoking events use the Slice 1 `membership_source_events` ledger,
keyed by `(source='stripe', source_event_id=event.id)`, for full replay/reject
semantics via the canonical payload hash.

### Rate limits

Persistent `town.ceremony_rate_limits` with hashed account subjects:

- `billing_checkout_account` — 5 attempts / 30 minutes
- `billing_portal_account` — 10 attempts / 30 minutes

### Identity security events

New bounded event types (never contain Stripe identifiers, checkout/portal URLs,
raw bodies, or signature headers):

- `stripe_checkout_session_created`
- `stripe_customer_linked`
- `stripe_webhook_received`
- `stripe_webhook_verified`
- `stripe_webhook_replayed`
- `stripe_webhook_rejected`
- `stripe_subscription_linked`
- `stripe_invoice_paid`
- `stripe_cancellation_scheduled`
- `stripe_cancellation_removed`
- `stripe_subscription_deleted`
- `stripe_payment_failed`
- `stripe_price_mismatch`

### Architecture contract

Slice 2 contract lives in `docs/billing-foundation.v1.json`:

```bash
npm run billing:contract:generate
npm run billing:contract:check
```

### Slice 2 exclusions

Explicitly out of scope for this slice:

- Public exposure of Stripe customer, subscription, invoice, or payment IDs.
- Storing Checkout or Portal URLs beyond the immediate response body.
- Direct membership entitlement mutation from routes (Slice 1 transitions only).
- Additional webhook event types beyond those enumerated.
- Trial subscriptions, paused subscriptions, non-annual pricing, or multi-line
  subscriptions.
- Worker-based webhook processing, Redis, or queues.

### Explicit exclusions

Still not implemented:

- JWTs
- recovery login / session issuance from recovery
- production recovery email delivery
- local verification
- Railway / web integration / mobile integration / deployment

## Other endpoints

| Method   | Path                                                     | Behavior                                        |
| -------- | -------------------------------------------------------- | ----------------------------------------------- |
| `GET`    | `/health/live`                                           | `{"status":"ok"}` (no DB)                       |
| `GET`    | `/health/ready`                                          | component readiness `ready` / `not_ready`       |
| `GET`    | `/health/build`                                          | immutable runtime build identity                |
| `GET`    | `/v1/communities`                                        | active communities by position                  |
| `GET`    | `/v1/communities/:communitySlug/signals`                 | published signals by position                   |
| `GET`    | `/v1/signals/:signalId`                                  | one published signal by UUID                    |
| `POST`   | `/v1/account/email-verifications`                        | gated email verification request                |
| `POST`   | `/v1/account/email-verifications/complete`               | gated email verification completion             |
| `POST`   | `/v1/account/passkeys/registration/options`              | first-passkey registration options (SetupGrant) |
| `POST`   | `/v1/account/passkeys/registration/verify`               | first-passkey registration verify (SetupGrant)  |
| `POST`   | `/v1/authentication/passkeys/options`                    | gated passkey authentication options            |
| `POST`   | `/v1/authentication/passkeys/verify`                     | gated passkey authentication verify             |
| `GET`    | `/v1/authentication/session`                             | current authentication session state            |
| `POST`   | `/v1/authentication/session/rotate`                      | rotate current authentication session           |
| `POST`   | `/v1/authentication/logout`                              | logout current authentication session           |
| `POST`   | `/v1/authentication/logout-all`                          | logout all account sessions                     |
| `GET`    | `/v1/account/passkeys`                                   | list active passkeys                            |
| `POST`   | `/v1/account/security/reauthentication/passkeys/options` | security reauthentication options               |
| `POST`   | `/v1/account/security/reauthentication/passkeys/verify`  | security reauthentication verify                |
| `POST`   | `/v1/account/passkeys/add/options`                       | add-passkey options (session + freshness)       |
| `POST`   | `/v1/account/passkeys/add/verify`                        | add-passkey verify (session + freshness)        |
| `PATCH`  | `/v1/account/passkeys/:passkeyId`                        | rename passkey                                  |
| `DELETE` | `/v1/account/passkeys/:passkeyId`                        | revoke passkey                                  |
| `GET`    | `/v1/account/membership`                                 | membership entitlement + civic access view      |
| `POST`   | `/v1/billing/checkout-session`                           | create a Stripe Checkout Session                |
| `POST`   | `/v1/billing/customer-portal-session`                    | open a Stripe Customer Portal Session           |
| `POST`   | `/v1/billing/stripe/webhook`                             | signature-verified Stripe webhook               |

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

| Script                                 | Purpose                                          |
| -------------------------------------- | ------------------------------------------------ |
| `npm run db:generate`                  | generate reviewable SQL                          |
| `npm run db:check`                     | validate migration history                       |
| `npm run db:migrate`                   | apply committed migrations (local/`tsx`)         |
| `npm run db:migrate:production`        | apply migrations via compiled Node entrypoint    |
| `npm run db:migrate:test`              | clean-DB migration verification                  |
| `npm run db:migrate:verify`            | non-mutating drizzle ledger verification         |
| `npm run smoke:deployment`             | deployment smoke checks (see docs/operations)    |
| `npm run db:seed:foundation`           | upsert canonical civic content                   |
| `npm run db:seed:controlled-actor`     | upsert the single controlled test actor          |
| `npm run identity:fixtures:load`       | load deterministic identity fixtures (test-only) |
| `npm run identity:contract:generate`   | write identity architecture contract             |
| `npm run identity:contract:check`      | verify committed identity contract               |
| `npm run auth:fixtures:load`           | load deterministic ceremony fixtures (test-only) |
| `npm run auth:contract:generate`       | write ceremony architecture contract             |
| `npm run auth:contract:check`          | verify committed ceremony contract               |
| `npm run membership:contract:generate` | write membership foundation contract             |
| `npm run membership:contract:check`    | verify committed membership contract             |
| `npm run billing:contract:generate`    | write billing foundation contract                |
| `npm run billing:contract:check`       | verify committed billing contract                |
| `npm test`                             | unit tests (no PostgreSQL required)              |
| `npm run test:integration`             | PostgreSQL 18 integration suite                  |
| `npm run check`                        | non-destructive quality gate                     |

## Deployment Readiness V1

Runtime deployment surface — health/build, readiness components,
graceful shutdown, advisory-locked migration runner, structured logging,
container image, and smoke tooling — is documented in
[`docs/operations/DEPLOYMENT_READINESS_V1.md`](docs/operations/DEPLOYMENT_READINESS_V1.md).
Use [`docs/operations/DEPLOYMENT_CHECKLIST_V1.md`](docs/operations/DEPLOYMENT_CHECKLIST_V1.md)
for every staging or production deployment.

## CI

GitHub Actions uses Node.js 24 and a PostgreSQL 18 service container with CI-only credentials (no GitHub secrets, no Railway).

CI runs format/lint/typecheck/unit tests, migration checks, foundation + controlled-actor seeds, confirmation + identity + ceremony integration coverage, live OpenAPI check, identity + ceremony contract checks, build, and dependency audits.

## Out of scope

Current repository exclusions (not a claim that Stripe is unimplemented):

- JWTs
- recovery login sessions / production recovery email
- public password or social login
- GPS / residency / production local verification evidence plumbing
- confirmation removal / confirmation totals / comments / moderation
- notifications / admin tooling
- Redis / queues / workers / GraphQL
- Flutter client development, Google Play / Apple In-App Purchase as the
  current launch payment path, and native Android/iOS app-store distribution
- Railway CLI / platform automation from this documentation slice

Stripe Checkout, Customer Portal, and `POST /v1/billing/stripe/webhook` **are
implemented** (flag-gated by `STRIPE_BILLING_ENABLED`; see Slice 2 above).
Stripe is the sole membership payment provider for the responsive web launch.
Google Play code remains in-tree and flag-gated off by default.
