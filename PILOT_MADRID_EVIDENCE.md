# Pilot Madrid — dovezi (M0 + addendum hostname)

Verificat 2026-08-16, direct pe `origin/main` proaspăt fetch-uit (nu pe
referințe locale nefetch-uite — vezi nota de corecție de la final).

## SHA-uri reale

- `town-api` `main` = `0ad0db4acab22844807a20c081d599e309e4a825`
- `town-public` `main` = `9eac1b3ca83fdcf3ee3b69f7763d544680ad6cac`
- Ambele branch-uri de sesiune (`claude/madrid-pilot-analysis-rm82b9`) sunt
  identice cu `main` — fără drift.

## 1. Madrid în sistem

- Comunitate: `slug: 'madrid-es'` — `town-api/src/db/seeds/foundation-content.ts:280`.
- Frontend: același `slug` în `town-public/community-commitment.js`,
  `CITY_BY_COUNTRY.Spain`.
- Cele 3 semnale — `foundation-content.ts:2052-2153`:
  1. Calle Argumosa, `area: 'Lavapiés'` — corect.
  2. Farolas Parque Tierno Galván, **`area: 'Vallecas'`** — eroare
     confirmată (linia 2093); parcul e real în Legazpi/Arganzuela.
  3. Puerta de Alcalá / Retiro, `area: 'Retiro'` — corect.
- Filtrare pe oraș, deja existentă, fără duplicare de cod:
  `GET /v1/communities/:communitySlug/signals` — `town-api/src/routes/signals.ts`.

## 2. Arhitectura hostname-ului

- Detectare hostname (doar prod/staging, nu per oraș):
  `town-public/api-base.js`.
- CORS + CSRF + WebAuthn folosesc **aceeași listă** de origini permise:
  `WEBAUTHN_ALLOWED_ORIGINS` — `town-api/src/ops/cors-origins.ts`,
  `src/ceremony/passkey-authentication/csrf.ts`.
- WebAuthn RP ID = `towncivic.org` (compatibil nativ cu subdomenii, per
  standard) — `src/ceremony/passkey-registration/policy.ts:16`.
- Lock de un-singur-origin în producție:
  `assertProductionWebAuthnPolicy()` — `src/ceremony/passkey-registration/config.ts:188-199`.
  Verificat din nou pe `main` real: singura schimbare față de vechea
  verificare e trecerea de la `NODE_ENV` la `APP_ENV` ca declanșator
  (`config.ts`, diff 2 linii) — lock-ul de un-singur-origin rămâne identic.
- Cookie de sesiune: Secure, HttpOnly, SameSite=Lax, **fără atribut Domain**
  — `src/plugins/openapi.ts:87`, confirmat în toate rutele de autentificare.
  Fiind subdomenii ale aceluiași domeniu înregistrat, `madrid.towncivic.org`
  e „same-site” cu `api.towncivic.org` — SameSite=Lax nu blochează.
- CSP: definit în `town-public/Caddyfile`, bazat pe `'self'` — nu necesită
  schimbare pentru un subdomeniu nou. Test dedicat:
  `town-public/scripts/test-security-headers-config.js`.
- Email verificare/recuperare: doar cod text simplu, fără link/hostname —
  `src/ceremony/email-verification/messages.ts`. Gol găsit: nicio variantă
  în spaniolă (doar it/de/en).
- Stripe: `STRIPE_CHECKOUT_SUCCESS_URL` / `CANCEL_URL` sunt variabile de
  mediu unice, globale, nu per-subdomeniu — `src/billing/checkout-service.ts`.
  Recomandare: accesul pilot să treacă prin `accessUntil`, nu prin Stripe.

## 3. Media

- Foto: JPEG/PNG/WEBP ≤5MB. Video: MP4 ≤32MB. Verificare magic-bytes
  anti-spoofing. — `src/membership/discussion-media-policy.ts`.

## 4. Acces / entitlement

- `MembershipEntitlementRow.accessUntil` — mecanism generic, deja existent,
  verificat prin `isMembershipTemporallyValid()` — `src/membership/civic-access.ts:16-19`.

## M2 — Staging (2026-08-16)

- Domeniu custom Railway creat pe `town-public-staging` (env `staging`,
  service `87e263a6-d8dd-487e-8d58-fbe5f952a3a8`): `madrid-staging.towncivic.org`
  → CNAME `xey4zpuf.up.railway.app`. Railway administrează DNS-ul pentru
  `towncivic.org` nativ (nameservers `*.name.com` gestionate de Railway) —
  CNAME-ul a apărut automat în panoul de domenii, fără acțiune manuală.
- `town-api-staging`: `list-variables` întoarce doar numele, nu valorile
  (`valuesRedacted: true`) — sesiunea nu poate citi `WEBAUTHN_ALLOWED_ORIGINS`
  curent. Nemodificat, ca să nu risc suprascrierea originii existente de
  Staging.
- Mecanism reutilizat, fără duplicare: `PRODUCT_ONLY_CITY_ORDER`
  (`town-public/script.js:4256`, mod „product-only” deja activ pt. tot
  site-ul) restrâns la `['Madrid']` pe hostname-urile pilot, prin noul
  `town-public/madrid-pilot-host.js`. `productOnlyScenes()` degradează
  corect pentru vizitatori anonimi; membrii cu home-city existent în altă
  comunitate mai văd și acea comunitate pe hostname-ul Madrid — comportament
  neschimbat de acest patch, de tratat explicit în M4 (acces/cohortă).
- Teste: `scripts/test-madrid-pilot-host.js` (nou, 12 assertions) +
  `test-api-base.js`, `test-community-commitment.js`,
  `test-security-headers-config.js`, `test-build-identity.js` — toate verzi.
  Suita E2E Playwright completă nu a fost rulată (cere servicii pornite).
- Commit: `town-public@8476e01`.
- `WEBAUTHN_ALLOWED_ORIGINS` pe `town-api-staging` extins manual de owner
  (Railway nu expune valorile prin acest tip de acces, deci sesiunea n-a
  putut face update-ul singură fără risc de suprascriere). Valoare
  confirmată: `https://towncivic.org,https://town-public-staging-staging.up.railway.app,https://madrid-staging.towncivic.org`.
- Deploy `80d2952c-49e6-4be1-b049-f92e55871be9` (commit `0ad0db4`,
  `town-api-staging`): `SUCCESS`. Log de pornire: „Server listening at
  http://127.0.0.1:8080”, `GET /health/ready` → `200`, zero eroare de
  configurare.
- Selector țară/oraș: `go()` (`script.js:13609`) redirecționează orice
  rută în afara `feed` înapoi la feed în modul product-only, cu excepția
  câtorva „journeys” explicite — inclusiv „city discovery”, singurul punct
  de intrare real spre `view-country`/`view-city` (confirmat: flag-ul
  `cityDiscoveryJourneyActive` e setat `true` într-un singur loc,
  `beginCityDiscoveryJourney()`, apelat doar din click-ul pe povestea de
  discovery din feed). `currentScenes()` (`script.js:8707`) nu mai inserează
  acea poveste când `madridPilotCityId` e setat — commit `town-public@f8de6ca`.
  Fără acel click, ruta rămâne inaccesibilă prin garda generică din `go()`.
- CORS live: **nu s-a putut testa.** Verificat prin
  `curl "$HTTPS_PROXY/__agentproxy/status"`: proxy-ul de ieșire al acestui
  mediu respinge explicit (`connect_rejected`, „policy denial”) conexiuni
  către `api-staging.towncivic.org` și `madrid-staging.towncivic.org`.
  Concluzia PASS se bazează pe trasarea directă a `src/plugins/cors.ts`:
  `origin` callback face `allowed.has(requestOrigin)` pe exact mulțimea
  construită din `WEBAUTHN_ALLOWED_ORIGINS` la pornire — determinist, fără
  altă logică. Comanda pentru verificare live manuală, de rulat de owner:
  `curl -i -X GET "https://api-staging.towncivic.org/health/ready" -H "Origin: https://madrid-staging.towncivic.org"`.
- Deploy `80d2952c-49e6-4be1-b049-f92e55871be9` (commit `0ad0db4`, `town-api-staging`):
  `SUCCESS`. Log de pornire verificat direct: „Server listening at
  http://127.0.0.1:8080”, `GET /health/ready` → `200`, zero eroare de
  configurare WebAuthn/CORS/CSRF.

## 5. Rezultat public

- Stadiu `archived` cu propunere câștigătoare, jurnal de dovezi public,
  tally delivered/not-delivered — `src/routes/civic-verification.ts:229`.

## 6. Gate de stabilizare — restore

- `STATUS.md` (ultima actualizare 11 aug.) afirmă „niciun restore executat”.
- Verificat direct în GitHub Actions (`Production restore drill`,
  workflow id `332962203`): 8 rulări, primele 7 eșuate (12 aug.), **a 8-a
  reușită integral pe 13 aug. 14:16–14:31 UTC**, toți cei 9 pași, inclusiv
  „Report RPO / RTO and attestation values”.
- Concluzie: gate-ul are acum infrastructură reală și o rulare reușită, dar
  documentul de status e stale, iar înregistrarea de atestare din bază de
  date nu a fost confirmată independent (necesită acces `ops_admin`, pe
  care sesiunea nu-l are). Marcat **parțial**, nu PASS.

## Notă de corecție (auto-raportată)

Raportul M0 inițial a comparat branch-ul de sesiune cu un `origin/main`
local nefetch-uit și a raportat greșit un „drift” de 54/8 fișiere. După
`git fetch` real, branch-ul de sesiune s-a dovedit identic cu `main` — fără
drift. Toate fișierele pe care s-au bazat concluziile din raportul M0 au
fost re-diff-uite explicit între referința veche și `main` real; singura
schimbare găsită e cea de mai sus (`config.ts`, `NODE_ENV`→`APP_ENV`), fără
impact asupra concluziilor.
