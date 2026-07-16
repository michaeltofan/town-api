# town-api

TOWN API foundation with Fastify 5, strict TypeScript, TypeBox, and a minimal PostgreSQL 18 + Drizzle ORM foundation.

This repository intentionally contains **platform foundation only**. Product domain features remain out of scope.

## Requirements

- Node.js **24+** (see `.nvmrc`)
- npm 11+
- PostgreSQL **18** for local integration/migration testing

## Architecture

- HTTP: Fastify 5 + TypeBox schemas
- Database driver: `pg` (node-postgres) connection pool
- ORM: Drizzle ORM over the same pool
- Migrations: versioned SQL under `drizzle/` via Drizzle Kit
- OpenAPI 3.1: generated deterministically from route schemas into `docs/openapi.v1.json`

Rules for this slice:

- Migrations are **versioned SQL** committed to the repository.
- `drizzle-kit push` is **not used**.
- Application startup **does not run migrations**.
- One bounded `pg.Pool` is created explicitly per process (or injected in tests).

## Quick start

```bash
nvm use
npm ci
cp .env.example .env
# edit DATABASE_URL for your local PostgreSQL 18 instance
npm run db:migrate
npm run dev
```

## Environment

| Variable                   | Default       | Description                  |
| -------------------------- | ------------- | ---------------------------- |
| `HOST`                     | `0.0.0.0`     | Bind address                 |
| `PORT`                     | `3000`        | HTTP port                    |
| `NODE_ENV`                 | `development` | Runtime mode                 |
| `LOG_LEVEL`                | `info`        | Pino log level               |
| `DATABASE_URL`             | _(required)_  | PostgreSQL connection string |
| `DB_POOL_MAX`              | `5`           | Max pool connections (1–50)  |
| `DB_CONNECTION_TIMEOUT_MS` | `5000`        | Connection timeout           |
| `DB_IDLE_TIMEOUT_MS`       | `30000`       | Idle client timeout          |

`.env` files are gitignored. `.env.example` contains placeholders only.

## Health endpoints

| Method | Path            | Behavior                                                                                             |
| ------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`  | `/health/live`  | Always `{"status":"ok"}` when process is up. Does **not** query PostgreSQL.                          |
| `GET`  | `/health/ready` | `200 {"status":"ready"}` when PostgreSQL readiness succeeds; `503 {"status":"not_ready"}` otherwise. |

## Database commands

| Script                    | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `npm run db:generate`     | Generate reviewable SQL migrations from TypeScript schema |
| `npm run db:check`        | Validate committed migration history                      |
| `npm run db:migrate`      | Apply committed migrations (requires `DATABASE_URL`)      |
| `npm run db:migrate:test` | Reset + migrate + verify schema `town` on a test DB       |

Migration V1 creates only:

```sql
CREATE SCHEMA IF NOT EXISTS "town";
```

No product tables are created.

## Tests

| Script                     | Description                                               |
| -------------------------- | --------------------------------------------------------- |
| `npm test`                 | Unit tests (no PostgreSQL required; DB injected)          |
| `npm run test:integration` | PostgreSQL 18 integration tests (requires `DATABASE_URL`) |
| `npm run check`            | Non-destructive quality gate (no production/Railway)      |

Example integration run against local PostgreSQL 18:

```bash
export DATABASE_URL=postgres://town_test:town_test@127.0.0.1:5432/town_test
npm run db:migrate:test
npm run test:integration
```

## CI

GitHub Actions uses:

- Node.js 24
- PostgreSQL 18 service container with isolated CI-only credentials
- `npm ci`, format, lint, typecheck, unit tests
- `db:check`, `db:migrate:test`, integration tests
- OpenAPI check and production build

CI does **not** use GitHub repository secrets and does **not** connect to Railway.

## Project layout

```text
src/
  config/env.ts
  db/
    client.ts
    lifecycle.ts
    schema.ts
    plugin.ts
  routes/health.ts
  app.ts
  server.ts
drizzle/                 # committed versioned SQL + metadata
docs/openapi.v1.json
test/
  *.test.ts              # unit tests
  database.test.ts       # PostgreSQL integration
  readiness.test.ts      # PostgreSQL readiness integration
```

## Out of scope

This slice still does **not** include:

- communities, signals, confirmations
- users, authentication, passkeys, sessions, membership
- Stripe, GPS, moderation
- seed content
- Railway deployment
- town-public integration
- town-safe-space-mobile integration
- Redis, queues, workers, GraphQL, Docker deploy files, PgBouncer
