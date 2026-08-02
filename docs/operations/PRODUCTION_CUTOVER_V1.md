# Production cutover V1 — `api.towncivic.org` + Stripe live

Goal: stand up a real production API so the first **€12 live** membership payment can succeed. Staging already proved the sandbox loop (Checkout `cs_test_` → webhook → `membership.active`).

## Current state (2026-08-02)

| Item | Status |
| --- | --- |
| Staging API | Live: `https://api-staging.towncivic.org` |
| Staging Stripe | Test mode (`sk_test_…`, `STRIPE_EXPECTED_LIVEMODE=false`) |
| Sandbox payment proof | Done on staging (test card → entitlement `active`, `source:stripe`) |
| Production API host | **Not provisioned** (`api.towncivic.org` NXDOMAIN) |
| Public site API pointer | `ACTIVE_API_BASE = STAGING_API_BASE` in `town-public/api-base.js` |
| Staging CORS override | `ALLOW_PRODUCTION_WEB_ORIGIN=true` (lets `towncivic.org` call staging) |

## Do not flip the frontend early

Do **not** change `ACTIVE_API_BASE` to production until:

1. `https://api.towncivic.org/health/live` → 200  
2. `https://api.towncivic.org/health/ready` → 200 (`config/database/migrations` all `ok`)  
3. `https://api.towncivic.org/health/build` → `environment: "production"`  
4. `npm run smoke:deployment -- --base-url https://api.towncivic.org --environment production --expect-commit <sha>` passes  
5. Stripe **live** webhook is configured for production  

Flipping earlier breaks login, membership, and checkout on `towncivic.org`.

## Operator steps (Railway + DNS + Stripe)

These actions require a Railway account token with **create** permission (project deploy tokens that can only read staging are not enough), Name.com DNS access, and Stripe live keys.

### A. Railway production environment

In project `town-public` (same project that hosts `town-api-staging`):

1. Create environment **`production`** (duplicate from `staging` is fine as a starting topology).
2. Ensure production has its **own Postgres** (do not point production `DATABASE_URL` at the staging database).
3. Add services equivalent to staging:
   - `town-api` (GitHub `michaeltofan/town-api`, branch `main`, Dockerfile, Amsterdam / `europe-west4`)
   - one-off migrations service / release step: `npm run db:migrate:production`
   - do **not** run staging seed against production
4. Attach custom domain: `api.towncivic.org` → production API service (port 8080 / app port).

### B. Production environment variables (fail-closed)

Set at least:

| Variable | Production value |
| --- | --- |
| `APP_ENV` | `production` |
| `NODE_ENV` | `production` (or leave Railway default; policy is `APP_ENV`-only) |
| `ALLOW_PRODUCTION_WEB_ORIGIN` | `false` |
| `WEBAUTHN_RP_ID` | `towncivic.org` |
| `WEBAUTHN_ALLOWED_ORIGINS` | `https://towncivic.org` only |
| `STRIPE_BILLING_ENABLED` | `true` |
| `STRIPE_EXPECTED_LIVEMODE` | `true` |
| `STRIPE_SECRET_KEY` | **`sk_live_…`** (not test) |
| `STRIPE_WEBHOOK_SECRET` | live webhook signing secret |
| `STRIPE_ANNUAL_PRICE_ID` | live annual price id |
| `STRIPE_PORTAL_CONFIGURATION_ID` | live portal configuration |
| `STRIPE_CHECKOUT_SUCCESS_URL` | `https://towncivic.org/#/active` |
| `STRIPE_CHECKOUT_CANCEL_URL` | `https://towncivic.org/#/payment` |
| `STRIPE_PORTAL_RETURN_URL` | `https://towncivic.org/#/active` |
| Email / recovery | keep Resend mode + production-safe hash keys (no CI placeholders) |
| Backup | `DATABASE_BACKUP_PROVIDER=railway_postgres_pitr`, `DATABASE_BACKUP_PITR_ENABLED=true` |

Commit identity: Railway Git injects `RAILWAY_GIT_COMMIT_SHA` (required for production boot).

### C. DNS (Name.com)

`towncivic.org` NS is on Name.com. After Railway shows the required record for the custom domain, add:

- `api` → CNAME to the Railway target Railway displays for `api.towncivic.org`

Wait until DNS resolves and the Railway domain status is active / certificate issued.

### D. Stripe Dashboard (live mode)

1. Create / confirm live Product + annual Price (€12/year) and Customer Portal config.
2. Add webhook endpoint:  
   `https://api.towncivic.org/v1/billing/stripe/webhook`  
   Events must include at least the ones staging uses for activation (notably `invoice.paid`, plus checkout/subscription lifecycle events already handled by `town-api`).
3. Put the live `whsec_…` into Railway production `STRIPE_WEBHOOK_SECRET`.

### E. Migrate, roll, smoke

```bash
# one-off against production DATABASE_URL
npm run db:migrate:production
npm run db:migrate:verify

npm run smoke:deployment -- \
  --base-url https://api.towncivic.org \
  --environment production \
  --expect-commit <40-char-sha> \
  --authorized-origin https://towncivic.org
```

### F. Frontend cutover (`town-public`)

Only after smoke is green:

1. In `api-base.js`, set `ACTIVE_API_BASE = PRODUCTION_API_BASE`.
2. Deploy `town-public`.
3. On staging, set `ALLOW_PRODUCTION_WEB_ORIGIN=false` so the live site cannot keep using staging by accident.
4. Confirm `towncivic.org` calls only `api.towncivic.org` (platform login + membership).

### G. First real €12

1. Prefer a **non-owner** account (or accept owner if that is the only active account).
2. Commitment → Checkout → pay with real bank/card.
3. Confirm `GET /v1/account/membership` → `status: active`, `source` stripe, `accessUntil` ~+1 year.
4. Confirm participate (signal confirmation / contribution) still works.

## Agent / automation limits

- Slice 1 docs intentionally exclude Railway CLI, DNS, and Stripe dashboard automation.
- A read-scoped Railway project token can inspect staging but **cannot** create the production environment.
- Do not paste live secrets into git, PR bodies, or chat.

## Rollback

- Keep `ACTIVE_API_BASE` on staging until production smoke is green.
- If production misbehaves after cutover: flip `ACTIVE_API_BASE` back to staging **and** temporarily re-enable `ALLOW_PRODUCTION_WEB_ORIGIN=true` on staging only for the emergency window.
- Do not schema-rollback; forward-fix only.
