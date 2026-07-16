# town-api

TOWN API shared backend foundation: Fastify 5, strict TypeScript, TypeBox, PostgreSQL 18, Drizzle ORM, canonical civic content, controlled signal confirmation, and the Account Identity Foundation (database + architecture contract only).

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
- OpenAPI 3.1: deterministic generation into `docs/openapi.v1.json` (implemented routes only; no Swagger UI)
- Identity architecture contract: `docs/account-identity-contract.v1.json` (not live routes)

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

## Other endpoints

| Method | Path                                     | Behavior                           |
| ------ | ---------------------------------------- | ---------------------------------- |
| `GET`  | `/health/live`                           | `{"status":"ok"}` (no DB)          |
| `GET`  | `/health/ready`                          | DB readiness `ready` / `not_ready` |
| `GET`  | `/v1/communities`                        | active communities by position     |
| `GET`  | `/v1/communities/:communitySlug/signals` | published signals by position      |
| `GET`  | `/v1/signals/:signalId`                  | one published signal by UUID       |

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
| `npm test`                           | unit tests (no PostgreSQL required)              |
| `npm run test:integration`           | PostgreSQL 18 integration suite                  |
| `npm run check`                      | non-destructive quality gate                     |

## CI

GitHub Actions uses Node.js 24 and a PostgreSQL 18 service container with CI-only credentials (no GitHub secrets, no Railway).

CI runs format/lint/typecheck/unit tests, migration checks, foundation + controlled-actor seeds, confirmation + identity integration coverage, live OpenAPI check, identity contract check, build, and dependency audits.

## Out of scope

This slice still excludes:

- real email delivery
- WebAuthn ceremonies / live passkey login
- public account endpoints
- passwords / social login / sessions / cookies / JWTs
- membership
- Stripe
- GPS / residency verification
- confirmation removal / confirmation totals / comments / moderation
- notifications / admin tooling
- Redis / queues / workers / GraphQL
- web integration / mobile integration / Railway deployment
