# town-api

TOWN API foundation (V1): Fastify 5 + strict TypeScript with TypeBox schemas, health probes, committed OpenAPI 3.1 contract, linting, formatting, tests, and CI.

This repository intentionally contains **platform foundation only**. Domain features (auth, payments, GPS, moderation, PostgreSQL/Drizzle, etc.) are out of scope for V1.

## Requirements

- Node.js **24+** (see `.nvmrc`)
- npm 11+

## Quick start

```bash
nvm use
npm ci
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

| Method | Path            | Body                 |
| ------ | --------------- | -------------------- |
| `GET`  | `/health/live`  | `{"status":"ok"}`    |
| `GET`  | `/health/ready` | `{"status":"ready"}` |

Example:

```bash
curl -s http://127.0.0.1:3000/health/live
```

OpenAPI 3.1 is generated from Fastify/TypeBox schemas and committed at [`docs/openapi.v1.json`](docs/openapi.v1.json). There is no Swagger UI route.

## Scripts

| Script                     | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `npm run dev`              | Start with hot reload (`tsx watch src/server.ts`)  |
| `npm run build`            | Compile TypeScript to `dist/`                      |
| `npm start`                | Run compiled server (`node dist/server.js`)        |
| `npm run typecheck`        | Strict TypeScript check (no emit)                  |
| `npm run lint`             | ESLint (strict TypeScript rules)                   |
| `npm run format`           | Prettier write                                     |
| `npm run format:check`     | Prettier check                                     |
| `npm test`                 | Vitest suite                                       |
| `npm run test:coverage`    | Vitest with coverage                               |
| `npm run openapi:generate` | Regenerate `docs/openapi.v1.json`                  |
| `npm run openapi:check`    | Fail if generated OpenAPI differs from committed   |
| `npm run check`            | format + lint + typecheck + test + openapi + build |

## Project layout

```text
src/
  config/env.ts         # TypeBox-validated environment
  plugins/openapi.ts    # OpenAPI 3.1 generation (no UI)
  plugins/error-handler.ts
  routes/health.ts      # /health/live and /health/ready
  schemas/              # TypeBox schemas
  openapi/document.ts   # Deterministic OpenAPI serialization
  app.ts                # Fastify app factory
  server.ts             # Process entrypoint
scripts/openapi.ts      # openapi:generate / openapi:check
docs/openapi.v1.json    # Committed OpenAPI contract
test/                   # Vitest suite
.github/workflows/      # CI (Node 24)
```

## CI

GitHub Actions workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes and pull requests with Node.js 24:

1. `npm ci`
2. `format:check`
3. `lint`
4. `typecheck`
5. `test`
6. `openapi:check`
7. `build`

## Out of scope (V1)

- PostgreSQL / Drizzle / migrations
- Domain models and business routes
- Auth, Stripe, GPS, moderation
- Railway / mobile / public-site changes
- Swagger UI route
