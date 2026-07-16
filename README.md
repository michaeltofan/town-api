# town-api

TOWN API shared backend foundation: Fastify 5, strict TypeScript, TypeBox, PostgreSQL 18, Drizzle ORM, canonical civic content (communities + published signals), and the first persistent controlled signal confirmation capability.

## Requirements

- Node.js **24+** (see `.nvmrc`)
- npm 11+
- PostgreSQL **18** for local migration/seed/integration testing

## Architecture

- HTTP: Fastify 5 + TypeBox request/response schemas
- Database: bounded `pg` pool + Drizzle ORM
- Migrations: versioned SQL under `drizzle/` (no `drizzle-kit push`, no startup migration)
- Seeds: explicit `db:seed:foundation` and `db:seed:controlled-actor` only (never on server startup)
- OpenAPI 3.1: deterministic generation into `docs/openapi.v1.json` (no Swagger UI)

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

Minimal controlled-test actor table (not public users/accounts):

- fixed UUID controlled actor
- `kind = controlled_test`
- `status = active`
- `display_label = Controlled test actor`
- belongs to Milano (`milano-it`)

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

| Script                             | Purpose                                 |
| ---------------------------------- | --------------------------------------- |
| `npm run db:generate`              | generate reviewable SQL                 |
| `npm run db:check`                 | validate migration history              |
| `npm run db:migrate`               | apply committed migrations              |
| `npm run db:migrate:test`          | clean-DB migration verification         |
| `npm run db:seed:foundation`       | upsert canonical civic content          |
| `npm run db:seed:controlled-actor` | upsert the single controlled test actor |
| `npm test`                         | unit tests (no PostgreSQL required)     |
| `npm run test:integration`         | PostgreSQL 18 integration suite         |
| `npm run check`                    | non-destructive quality gate            |

## CI

GitHub Actions uses Node.js 24 and a PostgreSQL 18 service container with CI-only credentials (no GitHub secrets, no Railway).

CI runs format/lint/typecheck/unit tests, migration checks, foundation + controlled-actor seeds, confirmation persistence/concurrency coverage via integration tests, OpenAPI check, build, and dependency audits.

## Out of scope

This slice still excludes:

- public users / real accounts / email verification
- passkeys / passwords / social login / sessions
- membership
- Stripe
- GPS / residency verification
- confirmation removal / confirmation totals / comments / moderation
- notifications / admin tooling
- Redis / queues / workers / GraphQL
- web integration / mobile integration / Railway deployment
