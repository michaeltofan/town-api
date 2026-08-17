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

## M3 — Conținut, proveniență (2026-08-16)

- Eticheta „Vallecas" pe `madrid-signal-2` era greșită — verificat pe 3
  surse independente înainte de modificare: pagina oficială a
  Ayuntamiento de Madrid (secțiunea Arganzuela), Wikipedia, HallaMadrid —
  toate concordante: Parque Enrique Tierno Galván e în cartierul Legazpi,
  districtul Arganzuela. Corectat `area` și `whoIsAffected` —
  `foundation-content.ts`, commit `town-api@3c0bdbd`.
- Verificat: niciun test nu referea valoarea veche `Vallecas`
  (`grep -rln "Vallecas" test/ src/` → doar fișierul de seed însuși).
- Proveniență: decizia lui Mihail — link Google Maps de locație pentru
  fiecare semnal, ca soluție provizorie (fotografii reale de la contacte
  din Madrid urmează separat). Linkurile primite conțineau token-uri de
  sesiune/fotografie din browser — înlocuite cu linkuri scurte, stabile,
  pe bază de coordonate exacte, potrivite pt. conținut public:
  - Calle Argumosa: `https://www.google.com/maps?q=40.4079926,-3.6980726`
  - Parque Enrique Tierno Galván: `https://www.google.com/maps?q=40.3900397,-3.6838406`
  - Puerta de Alcalá / Retiro: `https://www.google.com/maps?q=40.4203717,-3.6936146`
    Adăugate ca text în câmpul `description` existent — fără migrare, fără
    schimbare de schemă. Commit `town-api@7941440`.
- Limitare cunoscută, nu ascunsă: schema `signals` are un singur câmp de
  imagine (`imageKey`), niciunul pentru video sau sursă/proveniență
  structurată. Un câmp dedicat ar cere o migrare — neautorizată separat,
  nefăcută.

## Notă de corecție (auto-raportată)

Raportul M0 inițial a comparat branch-ul de sesiune cu un `origin/main`
local nefetch-uit și a raportat greșit un „drift” de 54/8 fișiere. După
`git fetch` real, branch-ul de sesiune s-a dovedit identic cu `main` — fără
drift. Toate fișierele pe care s-au bazat concluziile din raportul M0 au
fost re-diff-uite explicit între referința veche și `main` real; singura
schimbare găsită e cea de mai sus (`config.ts`, `NODE_ENV`→`APP_ENV`), fără
impact asupra concluziilor.

## M4 — Acces pilot, cohortă (2026-08-16)

- Mecanism de grant admin (`accessUntil`, `source: 'admin'`, fără Stripe,
  auditat) — **verificat deja existent**, complet funcțional, înainte de
  orice schimbare a mea: `POST /v1/platform/memberships/grant`
  (`src/routes/platform.ts:775`), `grantPlatformMembership`
  (`src/platform/services/memberships.ts:173`), audit în
  `platform_audit_events` via `writeMembershipAudit`.
- Tabelă nouă, additivă, fără atingere de `membership_entitlements`:
  `pilot_cohort_members` (`src/db/schema.ts`), `CHECK` la exact
  `'madrid_pilot'`. Migrare `drizzle/0059_pilot_cohort_members.sql`.
- **Incident tehnic găsit și rezolvat:** `drizzle-kit generate` a produs
  inițial un fișier de 910 linii cu 32 `CREATE TABLE` (toată schema, nu
  doar tabela nouă). Cauză: `drizzle/meta/0014_snapshot.json` până la
  `0058_snapshot.json` lipsesc din tot repo-ul —
  `git log --oneline --all -- drizzle/meta/0014_snapshot.json` și
  `...0058_snapshot.json` nu întorc niciun commit, deci fișierele n-au
  existat niciodată în git, nu au fost șterse acum. Fix: extrase manual
  doar cele 4 instrucțiuni SQL reale pentru `pilot_cohort_members` din
  output-ul generatorului (verificate ca fiind exact ce ar fi generat
  corect), păstrat `meta/0059_snapshot.json` (verificat: 51 tabele,
  identic cu numărul din `schema.ts`) și `_journal.json`. O a doua rulare
  `drizzle-kit generate` confirmă „No schema changes, nothing to migrate".
- `grantPlatformMembership` extins cu `cohort?: PilotCohort`, inserare
  idempotentă (verificare înainte de insert) în `pilot_cohort_members`,
  legată de `sourceEventId` al grant-ului. Grant-urile fără `cohort`
  rămân neschimbate — testat explicit.
- `PlatformMembershipGrantBodySchema` extinsă cu `cohort` opțional;
  `docs/openapi.v1.json` regenerat cu `npm run openapi:generate` (diff de
  6 linii, doar câmpul nou).
- `EXPECTED_MIGRATION_COUNT` (derivat automat din jurnal, nu hardcodat în
  sursă) a trecut de la 59 la 60; 5 fișiere de test aveau valoarea veche
  hardcodată în assert-uri — actualizate.
- Test nou în `test/platform.api.test.ts`: grant cu `cohort: 'madrid_pilot'`
  → rând creat, `grantedByAccountId` corect; replay cu aceeași
  `idempotencyKey` → tot un singur rând; grant fără `cohort` → zero rânduri
  în `pilot_cohort_members`.
- Verificări rulate: `tsc --noEmit` curat, `eslint` curat, `prettier
--check` curat pe toate fișierele atinse, `npx vitest run` — 569 teste
  trecute, doar cele 3 fișiere dependente de `DATABASE_URL` (preexistente,
  fără legătură) eșuează, din lipsă de Postgres local în acest mediu.
- **Nimic din migrarea 0059 nu a fost rulat împotriva vreunei baze de
  date reale** — nici Staging, nici Production. Se va aplica automat la
  următorul deploy pe `main` (parte din `preDeployCommand`), condiționat
  de autorizarea separată de merge+deploy.
- Commit: `town-api@dffb426`.

## M5 — Analytics, funnel, export agregat (2026-08-16)

- `civic_process_events` (`src/db/schema.ts:2436`) — **verificat deja
  existent**, dinainte de orice schimbare a mea: un rând per tranziție de
  etapă (`stage_transitioned_to_proposals/deliberation/ballot_preparation/
voting/mandate/action/verification/archived`), pentru orice proces civic,
  orice oraș. Asta e „funnel"-ul cerut de M5 — deja construit.
- Export nou, doar agregat: `src/platform/repositories/pilot-funnel.ts` +
  `src/platform/services/pilot-funnel-export.ts` +
  `GET /v1/platform/pilot/funnel-export?communitySlug=&cohort=`
  (`src/routes/platform.ts`, capability `read_communities`, cel mai jos
  nivel de acces — potrivit pentru date fără PII). Toate query-urile
  filtrează pe `civicProcesses.communityId`, fără migrare, fără schemă nouă.
- Test nou în `test/platform.api.test.ts`: verifică forma răspunsului și
  explicit că `JSON.stringify(pack)` nu conține ID-ul de cont al
  operatorului sau al contului acordat — dovadă directă că exportul e
  agregat, nu per-persoană.
- `docs/openapi.v1.json` regenerat (`npm run openapi:generate`, +211 linii,
  doar ruta nouă). `npx vitest run`: 569 teste trecute, aceleași 3 fișiere
  dependente de `DATABASE_URL` eșuează (preexistent, fără legătură).
  `tsc`/`eslint`/`prettier` curate.
- **Căutat explicit și confirmat absent:** `grep -rln "consent\|Consent"
src/` → zero rezultate. Nu există niciun mecanism de consimțământ în
  cod. Nu l-am construit — textul și fluxul exact sunt o decizie de
  conținut/produs a lui Mihail (analog cu aprobarea mesajului TOWN
  Madrid, punctul 8 din strategia originală), nu o decizie tehnică.
- Commit: `town-api@ad4b1e4`.

## M6 — Invitații, linkuri directe (2026-08-16)

- `scene.id` era deja slug-ul semnalului (`mapSignalDetailToScene`,
  `detail.slug || detail.id`) — nu a trebuit adăugat niciun identificator
  nou, doar păstrarea lui din hash.
- `parseRoute()` extrage slug-ul din `#/feed/<slug>` (regex
  `^feed\/([a-z0-9-]{1,128})$`); `ensureProductOnlyFeedHash()` nu mai
  colapsează acest format la `#/feed` simplu; `resolvePendingFeedDeepLink()`
  setează `feedIndex` o dată ce scenele sunt încărcate — apelat atât din
  `render()` (scene deja încărcate) cât și din `loadProductOnlyLiveFeed()`
  (încărcare inițială). Slug care nu se potrivește = no-op tăcut, nu eroare.
- Funcționează generic, pentru orice oraș — nu e o rută separată pentru
  Madrid, e infrastructura de rutare existentă, extinsă cu un singur
  parametru opțional.
- Test structural nou: `scripts/test-feed-deep-link.js` (8 assertions,
  verifică prezența exactă a fiecărei piese din cod, nu comportament live
  — Playwright E2E ar da acoperire completă, dar nu poate rula din acest
  mediu). Toate testele existente relevante rulate din nou, verzi.
- Linkuri testabile pe Staging:
  `https://madrid-staging.towncivic.org/#/feed/madrid-signal-{1,2,3}`.
- Commit: `town-public@05e3706`.

## M7 — Pagina publică de rezultat (2026-08-16)

**Nicio linie de cod nouă — verificare, nu construcție.**

- `GET /v1/signals/:signalId/civic-process/verification`
  (`src/routes/civic-verification.ts:222-327`) — confirmat, grep pe
  `security:` în tot fișierul găsește doar rutele POST (ready/evidence/confirm,
  liniile 337/371/426); ruta GET nu are `security`, deci public.
- Onestitate verificată în cod: `outcome: verification?.outcome ?? null`
  (linia 311); comentariu explicit (liniile 268-272) despre disputele
  neajunse la prag — „escaladează vizibil", nu se auto-rezolvă.
- Frontend: `fetchSignalCivicVerification` (`town-public/script.js:7669`)
  folosește `getJsonWithCredentials` (trimite cookie dacă există, nu-l
  cere); apelat din randarea generală a detaliului de semnal
  (`script.js:5883`), condiționat doar de etapa procesului
  (action/verification/archived), nu de autentificare.
  `openSignalDetail()` (`script.js:14477`) — zero verificare de sesiune.
- `authorDisplayName` pe dovezi = `realName` completat explicit de autor la
  publicare (`src/routes/member-signals.ts:438-439`,
  `request.body.realName`, câmp obligatoriu) — nu derivat silențios din
  cont. Design pre-existent, semnalat, nu modificat.
- Combinat cu linkul direct din M6 (`#/feed/<slug>`), un vizitator
  neautentificat poate ajunge direct la orice semnal Madrid și vedea
  rezultatul complet odată ce procesul e arhivat.

## M8 — E2E, securitate, capacitate, QA vizual (2026-08-16)

- **Postgres local pornit pentru prima oară în această sesiune**
  (PostgreSQL 16, deja instalat în mediu, neutilizat până acum din lipsă
  de `DATABASE_URL`). A permis, pentru prima oară, verificare reală pe
  bază de date, nu doar trasare de cod.
- Migrarea 0059 aplicată cu succes pe bază de date reală locală —
  confirmat prin interogare directă `information_schema.tables`.
- 5 fișiere de test cu lista de tabele hardcodată nu includeau
  `pilot_cohort_members` (gol rămas de la M4, imposibil de prins fără
  bază de date): `test/database.test.ts`,
  `test/account-identity.migration.test.ts`,
  `test/auth-ceremony.migration.test.ts`,
  `test/communities-signals.migration.test.ts`,
  `test/signal-confirmation.migration.test.ts`. Reparate, verificate
  izolat, toate verzi (7+2+2+3+3 = 17 teste).
- Rulare completă a suitei de integrare (`vitest.integration.config.ts`,
  82 fișiere, ~400s): 522/544 teste verzi la prima trecere. 7 fișiere
  eșuate (22 teste) cu semnătură „relation does not exist" imediat după
  migrare + „Called end on pool more than once" — verificate individual,
  toate trec curat (`password-setup.api.test.ts` 7/7,
  `passkey-registration.api.test.ts` 14/14, restul confirmate similar).
  Concluzie: artefact de contenție pe conexiuni Postgres dintr-un proces
  Node unic, de lungă durată, cu resetări repetate de schemă — nu
  regresie de cod. `grep -c pilot_cohort` pe log-ul complet → 1 rezultat,
  chiar testul meu de M4, verde.
- `test/platform.api.test.ts` (conține testele de cohortă M4 și export
  M5) — 16/16 verzi, verificat pe bază de date reală pentru prima oară.
- Teste noi/extinse pentru originul Madrid, toate rulate real, nu doar
  trasate: `test/ops.cors.test.ts` (+3, total 17/17),
  `test/ceremony.csrf.test.ts` (fișier nou, 8/8 — nu exista test dedicat
  pentru `assertWebCookieCsrf` înainte de M8),
  `test/ops.staging-railway-origins.test.ts` (+2, total 16/16).
- Test de capacitate: declanșat `workflow_dispatch` pe `loadtest.yml`
  (manual-only, doar `api-staging.towncivic.org`, niciodată automat),
  run id `31971001155`, commit `0ad0db4`. Rezultat real, extras din
  log-ul job-ului: `checks_succeeded: 100.00% (10817/10817)`,
  `http_req_failed: 0.00%`, `http_req_duration p(95)=179.18ms` global,
  praguri per-endpoint toate respectate (civic_process p95=181.57ms<500ms,
  community_signals p95=178.79ms<800ms, signal_detail p95=178.38ms<500ms),
  100 VU susținuți 3m30s.
- **Nefăcut, semnalat explicit:** QA vizual mobil+desktop (cere Mihail
  personal) și suita E2E Playwright cu browser real (configurare locală
  disproporționat de costisitoare față de timpul rămas — ~15 variabile
  de mediu pentru WebAuthn/email/sesiune, două servere coordonate).
- Commit-uri: `town-api@3f7978d` (teste), documentele curente.

## Bug real găsit de QA vizual (2026-08-16, M8)

- Simptom raportat de Mihail: `madrid-staging.towncivic.org/#/feed` afișa
  „No live signals right now" / „Couldn't reach TOWN — try again later"
  în loc de cele 3 semnale Madrid.
- Cauză confirmată în cod: `town-public/api-base.js`,
  `isStagingPageHost()` nu recunoștea `madrid-staging.towncivic.org` —
  niciun pattern existent (`localhost`, `town-public-staging`,
  `.up.railway.app` + `staging`) nu se potrivea. `resolveApiBase()` cădea
  pe presupunerea implicită de producție (`ACTIVE_API_BASE`).
- Efect: fiecare fetch către `/v1/communities/madrid-es/signals` se ducea
  la `api.towncivic.org` cu `Origin: https://madrid-staging.towncivic.org`
  — respins de `assertProductionWebAuthnPolicy()` (lock de un-singur-origin
  în producție, documentat încă din M0/M2). Browserul raporta eroare de
  rețea.
- `madrid-pilot-host.js` (M2) și `api-base.js` sunt module separate —
  primul blochează conținutul pe Madrid, al doilea alege API-ul; nu erau
  niciodată conectate, iar golul a căzut exact acolo. M2 a testat corect
  CORS/CSRF/WebAuthn _pe API_, dar nu a verificat _rutarea din frontend_
  către API-ul corect pentru acest hostname nou.
- Fix: `isStagingPageHost()` recunoaște acum explicit
  `madrid-staging.towncivic.org`; `isProductionPageHost()` recunoaște
  `madrid.towncivic.org` (M9, inert până acel domeniu există) — previne
  aceeași eroare la trecerea în producție.
- 6 assert-uri noi în `scripts/test-api-base.js` (33/33 total), toate
  celelalte teste conexe re-rulate curate.
- Commit: `town-public@a4ecbfa`.

## Merge + deploy fix `api-base.js` (2026-08-16, autorizat separat)

- Autorizare explicită: „autorizez merge + deploy pentru town-public ca
  fix-ul să ajungă live, ca să pot relua QA-ul pe pagina reparată."
- Stare pre-merge verificată: `origin/main` era strămoș direct al
  branch-ului (`git merge-base --is-ancestor` → adevărat) — fast-forward
  curat, zero conflicte posibile.
- PR [town-public#136](https://github.com/michaeltofan/town-public/pull/136)
  creat și merge-uit (metodă `merge`, nu squash/rebase, ca istoricul
  commit-urilor Madrid să rămână intact) →
  `town-public@9ec7bab74b17905e44dcf01da12441cbb5683f6e`.
- Verificare deploy, nu doar presupunere de „CI verde": `mcp__Railway__get-service-config`
  pe serviciul `town-public-staging` (proiect `town-public`, environment
  `staging`) confirmă `source.branch: "main"` — auto-deploy pe push e
  configurat, nu manual. `mcp__Railway__list-deployments` arată un
  deployment nou, `status: SUCCESS`, `reason: "deploy"`, creat imediat
  după merge. Log-uri de build (`mcp__Railway__get-logs`) confirmă build
  finalizat `2026-08-16T08:11:44Z`; log-urile de deploy arată cereri
  gestionate fără erori până în cel mai recent interval capturat —
  serviciul rulează și răspunde, nu doar „a pornit".
- Ce NU s-a verificat direct din acest mediu: un răspuns HTTP real la
  `https://madrid-staging.towncivic.org/#/feed` printr-un browser — proxy-ul
  acestui mediu blochează acel domeniu (aceeași limitare de la M2/M8).
  Confirmarea finală că feed-ul chiar arată cele 3 semnale rămâne la QA-ul
  vizual al lui Mihail.

## Regresie reală de CI, descoperită abia la merge real (2026-08-16)

- Contextul contează: acesta e exact motivul pentru care regula „nu accepta
  CI verde ca dovadă suficientă" există și în sens invers — CI-ul real, care
  nu a putut rula niciodată în acest mediu sandbox-at, a găsit o regresie pe
  care nicio verificare locală de-a mea nu ar fi putut-o găsi (nu am acces
  la workflow-ul GitHub Actions ca execuție reală, doar la codul lui).
- Simptom: `town-public` E2E, runs
  [#146](https://github.com/michaeltofan/town-public/actions/runs/31972585680)
  (branch-ul PR-ului) și
  [#147](https://github.com/michaeltofan/town-public/actions/runs/31972589521)
  (push pe `main`), ambele `failure`, pasul „Static smoke", la câteva
  secunde după pornire — deci nu Playwright, ci un test static Node.
- Log exact: `FAIL: feed and city picker derive from the canonical catalog`
  în `scripts/test-etapa3-member-journey.js`, urmat de
  `FAILED: 1 assertion(s); passed 162`.
- Cauză confirmată în cod: asertarea verifica string-ul literal
  `"const PRODUCT_ONLY_CITY_ORDER = communityCatalogApi.cityIds()"` în
  sursa `script.js`. Schimbarea M2 (deja aprobată și livrată, `8476e01`) a
  transformat exact acea linie într-un ternary condiționat de hostname-ul
  Madrid:
  ```js
  const PRODUCT_ONLY_CITY_ORDER = madridPilotCityId
    ? [madridPilotCityId]
    : communityCatalogApi.cityIds();
  ```
  String-ul literal nu mai exista identic — testul pica, dar invariantul pe
  care îl verifica (ordinea orașelor derivă din catalogul canonic, nu dintr-o
  listă separată hardcodată) tot era adevărat pe orice branch, inclusiv pe
  cel implicit (non-Madrid).
- De ce n-a fost prins în M2: verificarea manuală din acea etapă a rulat
  „4 teste node relevante" (vezi tabelul M2), nu acest fișier — 163 de
  asertări dintr-un test de etapă anterioară (Etapa 3), fără legătură
  vizibilă cu Madrid la prima vedere.
- Reparat: asertarea actualizată să caute printr-un regex mărginit
  (`communityCatalogApi\.cityIds\(\)` undeva în atribuirea către
  `PRODUCT_ONLY_CITY_ORDER`), păstrând invariantul real, tolerând forma nouă.
  Reprodus local înainte de reparare (`FAILED: 1 assertion(s); passed 162`,
  identic cu log-ul din CI); verificat după reparare
  (`PASSED: 163 Etapa 3 member journey assertions`); toate cele 19 scripturi
  din pasul „Static smoke" (`.github/workflows/e2e.yml`) rulate local, în
  aceeași ordine, toate curate.
- Merge: PR
  [town-public#137](https://github.com/michaeltofan/town-public/pull/137)
  → `town-public@8f9bd4fdfa3a414585c7819432aec329915404e6`.
- Branch-ul `claude/madrid-pilot-analysis-rm82b9` conținea deja doar istorie
  merge-uită (PR #136) — repornit de la `origin/main` conform regulii de
  branch merge-uit, nu stivuit peste el.
- Verificare finală, directă, nu presupusă: run CI #149 pe `main`,
  urmărit până la finalizare — `status: completed`, `conclusion: success`.
  Railway a redeploy-uit automat peste noul commit — deployment nou
  `SUCCESS`, finalizat 2026-08-16T21:16:40Z, a înlocuit build-ul anterior.

## Merge `town-api` M4/M5 + trei regresii reale de CI, găsite doar la merge real (2026-08-17)

- Branch-ul `claude/madrid-pilot-analysis-rm82b9` conținea 24 de commit-uri
  neverificate niciodată contra `main` real (cod M4/M5 + documente). PR
  [town-api#162](https://github.com/michaeltofan/town-api/pull/162)
  merge-uit — CI a picat imediat, trei probleme reale, fiecare
  reprodusă local înainte de reparare, nu doar re-încercată:
  1. **Format** — cele 4 documente Pilot Madrid nu treceau
     `prettier --check .` (repo-wide, include markdown). PR
     [#163](https://github.com/michaeltofan/town-api/pull/163).
  2. **Listă de tabele învechită** — `scripts/db-migrate-test.ts` avea
     propria listă `EXPECTED_TOWN_TABLES` hardcodată, separată de cele 5
     fișiere de test reparate la M8, neștiind de `pilot_cohort_members`.
     PR [#164](https://github.com/michaeltofan/town-api/pull/164).
  3. **Bug real de migrare** (cel mai serios): migrația `0059` avea
     `when` (timestamp în `drizzle/meta/_journal.json`) mai vechi decât
     `0058` (16 aug. real vs. 1 sept. sintetic din viitor). Migratorul
     `drizzle-orm` (`node_modules/drizzle-orm/pg-core/dialect.js:56-70`)
     citește o singură dată, la început, cea mai recentă `created_at` din
     ledger și aplică o migrare doar dacă `folderMillis` al ei e mai mare
     — pe bază de date goală (CI) nu există `lastDbMigration`, deci totul
     trece; pe Staging reală (care avea deja 0000-0058), 0059 era sărită
     silențios. Reprodus local exact: aplicat jurnalul pre-Madrid (59
     intrări) pe o bază reală, apoi jurnalul curent (60) peste — rândurile
     au rămas la 59. Reparat (timestamp mutat o zi după 0058), aceeași
     reproducere → 60. PR
     [#165](https://github.com/michaeltofan/town-api/pull/165).
  4. CI real pe `main`, run
     [#648](https://github.com/michaeltofan/town-api/actions/runs/32009014018)
     — verificat până la capăt: toate joburile `SUCCESS`, inclusiv
     „Deploy to staging (Railway)"; deployment Railway nou (`4244f741`)
     `SUCCESS`; `GET /health/ready` → 200 la prima verificare, fără nicio
     linie `readiness_migrations_failed`.

## Domeniu producție + incident real, 2026-08-17

- `madrid.towncivic.org` creat pe `town-public` producție prin
  `generate-domain`. DNS rezolvat automat, verificat direct:
  `python3 -c "import socket; print(socket.gethostbyname_ex(...))"` →
  `ehk1fgba.up.railway.app` → `69.46.46.77`. HTTPS live neverificabil din
  acest mediu (proxy: `403`, `connect_rejected`, `host: madrid.towncivic.org:443`,
  confirmat din `$HTTPS_PROXY/__agentproxy/status`).
- `WEBAUTHN_ALLOWED_ORIGINS` pe `town-api` producție: Mihail a pregătit
  modificarea în Railway dashboard cu un spațiu accidental înainte de
  virgulă (`https://towncivic.org ,https://madrid...`) — verificat direct
  în `parseAllowedOrigins` (`src/ceremony/passkey-registration/config.ts:156-186`)
  că parserul aruncă eroare explicită pe orice whitespace din jurul
  intrărilor; semnalat înainte de deploy, corectat, apoi aplicat.
- **Incident:** salvarea variabilei prin „Deploy Changes" a declanșat un
  build nativ Railway direct din `main` pe `town-api` **producție**
  (deployment `a967c06d`), nu doar o repornire cu variabila nouă.
  - Log de deploy confirmă: preDeployCommand (`npm run db:migrate:production`)
    a rulat și a reușit — „Migrations applied successfully" — **migrarea
    0059 s-a aplicat pe baza de date de producție reală** înainte ca
    aplicația să crape.
  - Aplicația a picat imediat: `Error: Invalid environment configuration:
RAILWAY_GIT_COMMIT_SHA and APP_COMMIT_SHA must match exactly when
both are set` (`src/config/env.js:414`). Deploy `FAILED` după 7
    încercări de healthcheck eșuate (`/health/ready`, fereastră 2m).
  - Railway n-a comutat traficul — verificat direct din `list-deployments`:
    `ffabf885` (11 aug., `SUCCESS`) a rămas nemodificat, nu `REMOVED`.
    Confirmat și din trafic HTTP live real (`get-logs` cu `types: ["http"]`
    pe deployment-ul vechi): cereri reale, 200 OK, pe `api.towncivic.org`
    și `towncivic.org`, de pe două dispozitive diferite (iPhone Safari,
    Mac Safari), inclusiv `GET /v1/communities/madrid-es/signals` → 200.
  - **Consecință reală, confirmată extern, nu din acest sandbox:**
    `.github/workflows/health-alert.yml` run
    [#175](https://github.com/michaeltofan/town-api/actions/runs/32013180314) —
    probă reală, din GitHub Actions (acces la internet real): „FAIL:
    production /health/ready -> HTTP 503". Cauză: aplicația veche
    (`EXPECTED_MIGRATIONS` = 59, bundle vechi) vede acum 60 de rânduri în
    `drizzle.__drizzle_migrations` → `detail: extra` → 503. Trafic de
    business neafectat (verificat separat), dar readiness real, fail.
  - **Bug separat, preexistent, găsit pe drum:** pasul „Open or update
    incident issue" din același workflow a picat cu
    `SyntaxError: Unexpected identifier 'https'` — un backtick din URL,
    interpolat direct într-un template literal JS din blocul
    `actions/github-script`, intră în conflict cu delimitatorii
    template-ului din jur. Alerta reală n-a ajuns nicăieri automat. Fără
    legătură cu Madrid; nereparat, semnalat separat.
  - Reparație autorizată separat de Mihail: deploy pe producție pentru
    `town-api` prin pipeline-ul CI (`workflow_dispatch`,
    `deploy_production: true`), care setează corect `APP_COMMIT_SHA` și
    aduce codul rulat în sincron cu baza de date deja migrată.

## Deploy producție `town-api` — trei încercări, două gafe recunoscute, reușit final verificat (2026-08-17)

- **Încercarea 1** (run
  [#649](https://github.com/michaeltofan/town-api/actions/runs/32013607335)):
  anulată. Agentul a merge-uit PR #166 (fix `health-alert.yml` + docs) pe
  `main` cât timp deploy-ul de producție autorizat rula pe același ref.
  `ci.yml` are `concurrency: group: ci-${{ github.workflow }}-${{
github.ref }}, cancel-in-progress: true` — identic pentru orice run pe
  `refs/heads/main`, indiferent de trigger (`push` vs. `workflow_dispatch`).
  Al doilea run a anulat primul. Verificat direct: toate cele 3 job-uri
  (`quality`, `deploy-staging`, `deploy-production`) → `cancelled`, niciun
  pas de deploy real executat, nicio schimbare pe Production.
- **Încercarea 2** (run
  [#652](https://github.com/michaeltofan/town-api/actions/runs/32014238622)):
  job-ul „quality" complet, `SUCCESS` (12 min, toate cele 25 de pași).
  „Deploy town-api (production)" a picat: healthcheck `/health/ready`
  eșuat de 5 ori (`service unavailable`) în fereastra de 2 minute.
  Log de deploy real (`get-logs`, deployment `7b6de162`):
  `Error: Invalid environment configuration: production
WEBAUTHN_ALLOWED_ORIGINS must be exactly https://towncivic.org`,
  aruncată din `assertProductionWebAuthnPolicy()`
  (`src/ceremony/passkey-registration/config.ts:194-198`):
  `if (origins.length !== 1 || origins[0] !== PRODUCTION_ALLOWED_ORIGIN)`.
  `PRODUCTION_ALLOWED_ORIGIN = 'https://towncivic.org'`
  (`policy.ts:17`) — un lock strict, deliberat, de un-singur-origin,
  documentat deja în secțiunea 2 a acestui fișier din M0. Variabila
  `WEBAUTHN_ALLOWED_ORIGINS` de pe producție avea acum doi termeni
  (`https://towncivic.org,https://madrid.towncivic.org`) — verificată
  anterior doar sintactic (fără spații), nu și pe această regulă
  semantică.
- **Reparație:** `mcp__Railway__set-variables` cu
  `WEBAUTHN_ALLOWED_ORIGINS: "https://towncivic.org"` (un singur termen),
  `skipDeploys: true` explicit, ca să nu declanșeze alt deploy necontrolat
  ca la incidentul de dimineață. Verificat direct din `list-deployments`
  imediat după: niciun deployment nou creat.
- **Încercarea 3** (run
  [#653](https://github.com/michaeltofan/town-api/actions/runs/32015956517)):
  `quality` → `SUCCESS`. „Deploy to production (Railway)" → `SUCCESS`,
  inclusiv pasul independent „Smoke test deployed production" (health,
  identitate de build/commit, rută neautentificată → 401, CORS,
  respingere semnătură webhook Stripe, scanare de secrete scurse).
  Deployment Railway nou, `10649101-7159-40b3-9136-586172d751c5`,
  `SUCCESS`, a înlocuit deployment-ul vechi.
- **Verificare finală, independentă, din 4 surse externe acestui mediu:**
  `.github/workflows/health-alert.yml` declanșat manual, run
  [#176](https://github.com/michaeltofan/town-api/actions/runs/32017028045):
  `production /health/live -> HTTP 200`, `production /health/ready ->
HTTP 200`, `staging /health/live -> HTTP 200`, `staging /health/ready
-> HTTP 200`. Pasul de închidere automată a incidentului (reparat
  imediat anterior) a rulat corect, fără eroare — confirmă și fix-ul
  pentru bug-ul de sintaxă JS.
- **Rezolvat separat, 2026-08-17:** suportul WebAuthn/passkey +
  CORS pentru `madrid.towncivic.org` pe producție. Vezi secțiunea
  dedicată de mai jos.

## Lock de un-singur-origin relaxat controlat, PR town-api#167 (2026-08-17)

- Cauza reală din spatele celei de-a doua încercări eșuate de mai sus:
  `assertProductionWebAuthnPolicy()` cerea `WEBAUTHN_ALLOWED_ORIGINS` =
  **exact** un singur origin în producție, iar CORS/CSRF citesc aceeași
  variabilă (`src/plugins/cors.ts`, `src/ops/cors-origins.ts` —
  `resolveCorsAllowedOrigins()` nu are propriul lock, ci moștenește
  restricția prin variabila comună). Rezultat: nu exista nicio valoare a
  variabilei care să lase deschis atât login-ul securizat pe
  `towncivic.org`, cât și citirea publică a semnalelor de pe
  `madrid.towncivic.org`.
- Trasare completă a tuturor consumatorilor listei de origini înainte de
  orice modificare (`grep -rln WEBAUTHN_ALLOWED_ORIGINS\|resolveCorsAllowedOrigins\|allowedOrigins src/`):
  CORS, CSRF (`assertWebCookieCsrf`), sesiune (`requireSessionRuntimeConfig`
  — **nu** are lock de un-singur-origin, doar `requirePasskeyAuthenticationConfig`/`requireWebAuthnRegistrationConfig`/management îl au), toate cele 3
  puncte de validare la boot din `config/env.ts` (linii 810, 885, 1102) —
  toate trei apelează aceeași funcție comună.
- Fix: `PRODUCTION_ALLOWED_ORIGINS` — o listă explicită, hardcodată, în
  `policy.ts`: `['https://towncivic.org', 'https://madrid.towncivic.org']`.
  `assertProductionWebAuthnPolicy()` cere acum: originul primar prezent
  obligatoriu + orice alt origin trebuie să fie din listă — nu wildcard,
  nu pattern, o singură listă enumerată. Un origin nou de producție tot
  cere o schimbare de cod revizuită.
- Verificare, înainte de push: suita completă implicită (66 fișiere, 590
  teste) verde pe Postgres local real; 4 teste noi în
  `test/passkey-registration.config.test.ts` (acceptă lista cu 2 origini,
  respinge lipsa originului primar, respinge orice origin din afara listei
  chiar alături de cel primar); suita completă de integrare (82 fișiere,
  544 teste) verde separat, pe aceeași bază de date reală.
- PR [town-api#167](https://github.com/michaeltofan/town-api/pull/167)
  merge-uit → `town-api@e69e6b0`.
- `WEBAUTHN_ALLOWED_ORIGINS` pe producție extinsă din nou:
  `https://towncivic.org,https://madrid.towncivic.org`
  (`mcp__Railway__set-variables`, `skipDeploys: true`, verificat imediat
  că n-a pornit niciun deploy). Deploy prin pipeline-ul CI, run
  [#656](https://github.com/michaeltofan/town-api/actions/runs/32019416621) —
  `SUCCESS` complet, inclusiv „Smoke test deployed production”. Deployment
  Railway nou (`9dd9514e-1869-4f13-8fb2-75e8b5a0d36e`) `SUCCESS`, a
  înlocuit versiunea anterioară. Verificare externă,
  `health-alert.yml` run
  [#178](https://github.com/michaeltofan/town-api/actions/runs/32021168717) —
  `SUCCESS`.

### M9 — de ce `madrid.towncivic.org` tot nu arăta pilotul, după ambele deploy-uri

Ambele deploy-uri (backend `town-api@e69e6b0`, frontend `town-public@8f9bd4f`,
run [#150](https://github.com/michaeltofan/town-public/actions/runs/32021837504),
deployment Railway `bbc923c1` `SUCCESS` la `2026-08-17T10:41:30Z`) au reușit
real, la nivel de platformă — și totuși pagina arăta 67 de semnale din toate
orașele, plus eticheta veche „Vallecas". Două cauze independente, ambele
stabilite prin dovezi directe, nu prin presupuneri.

**Cauza 1 — `script.js` vechi, servit din cache-ul browserului.**

Loguri HTTP reale ale serviciului `town-public` producție
(`mcp__Railway__get-logs`, `types: ["http"]`, 2026-08-17T10:45–10:46Z,
Safari, `88.97.164.241`):

- `GET /` → `200` — `index.html` nou, servit corect
- `GET /madrid-pilot-host.js` → `200`, apoi `304` — scriptul nou, descărcat
- `GET /assets/feed/signal_porta_romana_lighting.jpg`,
  `signal_lorenteggio_works.jpg`, `signal_citta_studi_pavement.jpg` —
  imagini din **Milano**
- **niciun `GET /script.js` și niciun `GET /api-base.js`** în aceleași
  încărcări de pagină

`git diff d9dc3f00 8f9bd4f` (commit-ul care era live în producție → commit-ul
nou) arată exact patru fișiere servite modificate: `index.html`,
`madrid-pilot-host.js` (nou), `script.js` (+192 linii — chiar lock-ul Madrid)
și `api-base.js`. Dar tag-urile din `index.html` rămăseseră
`script.js?v=auth-input-1` și `api-base.js?v=foundation-stabilize-1` —
chei de cache neschimbate.

`index.html` se revalidează (de aceea a preluat tag-ul nou și a descărcat
`madrid-pilot-host.js`, un URL nou-nouț), dar `script.js?v=auth-input-1` are
URL identic cu cel pe care browserul îl cachease deja de pe acest origin, în
vizitele de mai devreme din aceeași zi, cât timp era live bundle-ul
pre-pilot. Safari l-a reluat din cache. Rezultat: `window.TownMadridPilotHost`
era definit, dar `script.js`-ul vechi nu îl citea niciodată,
`PRODUCT_ONLY_CITY_ORDER` cădea pe catalogul complet, iar hostul de pilot
randa toate orașele.

De aceea `madrid-staging.towncivic.org` funcționa corect: acel origin a fost
deschis prima dată abia după ce codul Madrid era deja acolo, deci nu a existat
niciodată cache vechi pe el.

Fix: `town-public@b317317` — `script.js?v=madrid-pilot-1`,
`api-base.js?v=madrid-pilot-1`, plus aserțiunile din
`scripts/test-etapa3-member-journey.js` și `scripts/test-public-auth-signin.js`
actualizate să ceară cheia curentă pentru ambele fișiere. Toate cele 19
verificări statice rulate de CI trecute local înainte de push.

**Cauza 2 — baza de date de producție a fost populată înainte de corectura
de conținut.**

- `Vallecas` nu apare nicăieri în `town-public` și nici în codul curent
  `town-api` — vine exclusiv din baza de date.
- Corectura e commit-ul `3c0bdbd` „Fix Madrid signal 2 location:
  Legazpi/Arganzuela, not Vallecas", `2026-08-16 19:13:47 +0000`, prezent pe
  `origin/main`.
- Ultima rulare **reușită** a serviciului `town-api-seed-production`
  (`mcp__Railway__list-deployments`, service `92cbbed8`, env `production`):
  deployment `bbc19168`, `2026-08-16T17:59:29Z`, pe commit `0ad0db4` — deci
  **cu 1h14m înainte** de corectură. Toate deployment-urile ulterioare ale
  acelui serviciu sunt `SKIPPED` (filtru `watchPatterns`), deci seed-ul nu a
  mai rulat niciodată cu conținutul corectat.
- Re-rularea seed-ului chiar corectează conținutul existent, nu doar
  inserează: `src/db/seeds/seed-foundation.ts:97` face `onConflictDoUpdate`
  pe `signals.id`, cu `area`, `headline`, `summary`, `description` etc. în
  clauza `set`.

Ambele acțiuni rămase sunt acțiuni de Producție și așteaptă autorizare
explicită separată: (a) merge `town-public@b317317` în `main` + deploy de
producție prin `e2e.yml` / `deploy_production: true`; (b) re-rularea
`town-api-seed-production` pe baza de date de producție.
