# town-api

TOWN API shared backend foundation: Fastify 5, strict TypeScript, TypeBox, PostgreSQL 18, Drizzle ORM, and the first canonical civic dataset (communities + published signals).

## Requirements

- Node.js **24+** (see `.nvmrc`)
- npm 11+
- PostgreSQL **18** for local migration/seed/integration testing

## Architecture

- HTTP: Fastify 5 + TypeBox request/response schemas
- Database: bounded `pg` pool + Drizzle ORM
- Migrations: versioned SQL under `drizzle/` (no `drizzle-kit push`, no startup migration)
- Seeds: explicit `db:seed:foundation` only (never on server startup)
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

All community and signal IDs are fixed UUIDs in `src/db/seeds/foundation-content.ts`. Seed execution never calls random UUID generators or `Date.now()`.

### Seed command

```bash
export DATABASE_URL=postgres://town:town@127.0.0.1:5432/town
npm run db:migrate
npm run db:seed:foundation
```

Seed behavior:

- deterministic and idempotent controlled upserts by fixed IDs
- no truncation / no deletion of unknown records
- running twice still yields exactly 2 communities and 6 signals
- not executed by migrations or application startup

Author `authorDisplayName` values are prototype editorial metadata, not verified user accounts.

Image storage is limited to `imageKey` + focus coordinates. No binaries, base64, CDN, or absolute production URLs.

## Read-only endpoints

| Method | Path                                     | Behavior                           |
| ------ | ---------------------------------------- | ---------------------------------- |
| `GET`  | `/health/live`                           | `{"status":"ok"}` (no DB)          |
| `GET`  | `/health/ready`                          | DB readiness `ready` / `not_ready` |
| `GET`  | `/v1/communities`                        | active communities by position     |
| `GET`  | `/v1/communities/:communitySlug/signals` | published signals by position      |
| `GET`  | `/v1/signals/:signalId`                  | one published signal by UUID       |

Publication filtering: only `publication_status = published` signals and `status = active` communities are returned.

## Local database workflow

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run db:seed:foundation
npm run dev
```

Useful scripts:

| Script                       | Purpose                             |
| ---------------------------- | ----------------------------------- |
| `npm run db:generate`        | generate reviewable SQL             |
| `npm run db:check`           | validate migration history          |
| `npm run db:migrate`         | apply committed migrations          |
| `npm run db:migrate:test`    | clean-DB migration verification     |
| `npm run db:seed:foundation` | upsert canonical civic content      |
| `npm test`                   | unit tests (no PostgreSQL required) |
| `npm run test:integration`   | PostgreSQL 18 integration suite     |
| `npm run check`              | non-destructive quality gate        |

## CI

GitHub Actions uses Node.js 24 and a PostgreSQL 18 service container with CI-only credentials (no GitHub secrets, no Railway).

CI runs format/lint/typecheck/unit tests, migration checks, foundation seed (+ count verification), integration tests, OpenAPI check, build, and dependency audits.

## Out of scope

This slice still excludes:

- users / test users / authentication / sessions / passkeys
- signal confirmations / membership
- Stripe / GPS / moderation / reports
- public content submission / content editing / admin tooling
- translation tables / search / pagination infrastructure
- Redis / queues / workers / GraphQL
- web integration / mobile integration / Railway deployment
