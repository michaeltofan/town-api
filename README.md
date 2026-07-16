# town-api

TOWN API foundation (V1): a Fastify 5 + strict TypeScript service scaffold with health probes, OpenAPI docs, linting, formatting, tests, and CI.

This repository intentionally contains **platform foundation only**. Domain features (auth, payments, GPS, moderation, PostgreSQL/Drizzle, etc.) are out of scope for V1.

## Requirements

- Node.js **24+** (see `.nvmrc`)
- npm 11+

## Quick start

```bash
nvm use
npm install
npm run dev
```

Server defaults:

| Variable    | Default       | Description    |
| ----------- | ------------- | -------------- |
| `HOST`      | `0.0.0.0`     | Bind address   |
| `PORT`      | `3000`        | HTTP port      |
| `NODE_ENV`  | `development` | Runtime mode   |
| `LOG_LEVEL` | `info`        | Pino log level |

Copy `.env.example` if you want a local env file (the process also reads shell env vars directly).

## Endpoints

| Method | Path         | Purpose                                  |
| ------ | ------------ | ---------------------------------------- |
| `GET`  | `/health`    | Liveness probe                           |
| `GET`  | `/ready`     | Readiness probe (no external deps in V1) |
| `GET`  | `/docs`      | Swagger UI                               |
| `GET`  | `/docs/json` | OpenAPI 3.1 document                     |

Example:

```bash
curl -s http://127.0.0.1:3000/health
```

## Scripts

| Script                 | Description                              |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | Start with hot reload (`tsx watch`)      |
| `npm run build`        | Compile TypeScript to `dist/`            |
| `npm start`            | Run compiled server                      |
| `npm run typecheck`    | Strict TypeScript check (no emit)        |
| `npm run lint`         | ESLint (strict TypeScript rules)         |
| `npm run format`       | Prettier write                           |
| `npm run format:check` | Prettier check                           |
| `npm test`             | Vitest suite                             |
| `npm run ci`           | Format + lint + typecheck + test + build |

## Project layout

```text
src/
  config/env.ts      # Zod-validated environment
  plugins/swagger.ts # OpenAPI + Swagger UI
  routes/health.ts   # /health and /ready
  app.ts             # Fastify app factory
  index.ts           # Process entrypoint
test/                # Vitest integration tests
.github/workflows/   # CI (Node 24)
```

## CI

GitHub Actions workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes and pull requests with Node.js 24:

1. `format:check`
2. `lint`
3. `typecheck`
4. `test`
5. `build`

## Out of scope (V1)

- PostgreSQL / Drizzle / migrations
- Domain models and business routes
- Auth, Stripe, GPS, moderation
- Railway / mobile / public-site changes
