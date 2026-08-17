# Pilot Madrid — status curent

Actualizat: 2026-08-16. Regula STATUS.md generală se aplică și aici: dacă nu
e în `main`, nu e real.

## Finalizat

- **M0 — inventar read-only.** Raport complet livrat, verificat pe
  `town-api@0ad0db4` / `town-public@9eac1b3` (= `main` real, fără drift).
  Zero modificări de cod în această etapă. Detalii: `PILOT_MADRID_EVIDENCE.md`.
- **M1 — planul, metricile, criteriile.** Cele 4 documente, aprobate.
- **M3 — conținut verificat, proveniență.** Vezi secțiunea dedicată mai jos.
- **M4 — cod complet, neaplicat pe nicio bază de date.** Vezi secțiunea dedicată mai jos.
- **M5 — export agregat, parțial.** Vezi secțiunea dedicată mai jos.
- **M6 — invitații și linkuri directe.** Vezi secțiunea dedicată mai jos.
- **M7 — pagina publică de rezultat.** Deja construită, verificată, zero cod nou. Vezi secțiunea dedicată mai jos.
- **M8 — E2E, securitate, capacitate, QA vizual.** Aproape închis (QA vizual real confirmat, desktop + mobil). Vezi secțiunea dedicată mai jos.

## Finalizat — M2 (Staging)

Autorizat și închis 2026-08-16. Stare reală pe fiecare criteriu din master plan:

| Criteriu M2                                                        | Stare                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domeniu custom `madrid-staging.towncivic.org` în Railway           | **PASS** — creat; Railway administrează DNS-ul pentru `towncivic.org` nativ, CNAME apărut automat, fără acțiune manuală necesară                                                                                                                                                                                                                                                                                                                    |
| Feed arată doar cele 3 semnale Madrid pe acel hostname             | **PASS** — `town-public@8476e01`, `madrid-pilot-host.js` + o linie în `script.js` (`PRODUCT_ONLY_CITY_ORDER`), teste noi + suita existentă relevantă verde, zero regresie                                                                                                                                                                                                                                                                           |
| Selector țară/oraș ascuns complet                                  | **PASS** — `town-public@f8de6ca`. Povestea „explorează alte orașe” (singurul punct de intrare spre `view-country`/`view-city` în modul product-only — confirmat prin trasarea codului din `go()`) nu mai e inserată în feed pe hostname-urile pilot Madrid; fără acel click, ecranele rămân inaccesibile                                                                                                                                            |
| Pornire Staging fără eroare de config WebAuthn (origin nou permis) | **PASS** — verificat direct din log-urile de deploy (`80d2952c`, commit `0ad0db4`): „Server listening”, `/health/ready` → 200, zero eroare de configurare                                                                                                                                                                                                                                                                                           |
| CSRF/CORS/passkey verzi pe originul nou                            | **PASS, verificat pe cod, nu live** — `src/plugins/cors.ts` face un simplu `Set.has(requestOrigin)` pe exact lista din `WEBAUTHN_ALLOWED_ORIGINS`; pornirea reușită confirmă că originul Madrid e în acea listă. Test HTTP live nu a fost posibil — proxy-ul acestui mediu blochează explicit `api-staging.towncivic.org` și `madrid-staging.towncivic.org` (verificat prin `$HTTPS_PROXY/__agentproxy/status`, `connect_rejected`, nu presupunere) |
| Niciun test existent nu regresează                                 | **Parțial** — 4 teste node relevante + verificare de sintaxă, verzi de fiecare dată; suita completă E2E (Playwright, cere servicii pornite) nu a fost rulată în această trecere                                                                                                                                                                                                                                                                     |

### WEBAUTHN_ALLOWED_ORIGINS — rezolvat

Mihail a citit valoarea curentă din Railway dashboard și a adăugat originul
nou manual, fără să șteargă ce era acolo. Valoare finală, confirmată:
`https://towncivic.org,https://town-public-staging-staging.up.railway.app,https://madrid-staging.towncivic.org`.
Deploy `80d2952c` verificat SUCCESS, pornire curată.

### Rămâne opțional, nu blocant

Un test HTTP live (curl/browser, cu `Origin: https://madrid-staging.towncivic.org`
către `api-staging.towncivic.org/health/ready`) ar da confirmarea finală
100% empirică, dar cere acces la internet pe care acest mediu nu-l are
pentru acest domeniu. Concluzia de mai sus se bazează pe trasare de cod
determinstă, nu pe presupunere — dar dacă vrei certitudinea completă,
comanda de mai jos, rulată de tine dintr-un terminal cu acces normal la
internet, ar confirma-o:

```
curl -i -X GET "https://api-staging.towncivic.org/health/ready" \
  -H "Origin: https://madrid-staging.towncivic.org"
```

Un răspuns cu header-ul `access-control-allow-origin: https://madrid-staging.towncivic.org`
închide complet acest punct.

## Finalizat — M3 (conținut, proveniență)

Autorizat și închis 2026-08-16.

| Criteriu M3                                                          | Stare                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eticheta Vallecas corectată sau păstrată, cu decizie explicită       | **PASS** — corectată la Legazpi/Arganzuela, verificat pe 3 surse independente (Ayuntamiento de Madrid, Wikipedia, HallaMadrid) înainte de schimbare. `town-api@3c0bdbd`         |
| Fiecare semnal are sursă/dovadă atașată, aprobată explicit de Mihail | **PASS, provizoriu** — link Google Maps de locație pentru fiecare din cele 3 semnale, decizie explicită a lui Mihail (nu fotografie reală a problemei încă). `town-api@7941440` |

**Notă păstrată, nu ascunsă:** Google Maps confirmă locația, nu problema
civică curentă (imaginile Street View pot fi vechi de ani). Poze/video
reale ale problemelor (trotuar, felinare, containere), de la contactele
din Madrid, rămân de adăugat înainte de M8 (QA vizual) sau M10 (testul cu
10 persoane) — vezi `PILOT_MADRID_DECISIONS.md`.

## Finalizat — M4 (acces pilot, cohortă) — cod gata, nimic rulat pe bază de date

Autorizat și închis 2026-08-16, cu o precizare importantă: **tot ce urmează
e cod scris, testat, verificat — nicio migrare, niciun grant real nu a
atins vreo bază de date (nici Staging, nici Production).**

| Criteriu M4                                             | Stare                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acces 90 zile prin `accessUntil`, fără Stripe           | **PASS — deja exista.** `POST /v1/platform/memberships/grant` era deja complet funcțional, cu `source: 'admin'`, înainte de această etapă                                                                                 |
| Acordarea e auditată (cine, cui, când)                  | **PASS — deja exista.** Fiecare grant scrie în `platform_audit_events` (`membership_granted`) — mecanism generic, nu specific Madrid                                                                                      |
| Cohorta Madrid marcată separat de membership-ul general | **PASS, cod nou.** Tabelă nouă `pilot_cohort_members`, complet separată de `membership_entitlements` — restricționată prin `CHECK` la exact `'madrid_pilot'` (nimic altceva nu poate intra acolo azi). `town-api@dffb426` |

**De făcut separat, autorizare distinctă:** migrarea `0059_pilot_cohort_members.sql`
trebuie rulată efectiv pe Staging (și apoi Production) — asta se întâmplă
automat la următorul deploy pe `main` (`preDeployCommand: npm run
db:migrate:production`/echivalentul de Staging), deci practic e legată de
autorizarea de merge+deploy, nu de o comandă separată.

**Găsit pe parcurs, nu al meu, dar semnalat:** fișierele de „snapshot"
drizzle pentru migrările 0014–0058 lipsesc din tot repo-ul (zero istoric
git) — asta a rupt `drizzle-kit generate`, care a încercat să recreeze
toată schema. Am ocolit-o extrăgând manual doar SQL-ul corect pentru
tabela nouă, verificat printr-o rulare ulterioară care confirmă „no schema
changes". Golul istoric (0014–0058) rămâne — următoarea persoană care
generează o migrare nouă va lovi aceeași problemă dacă nu e reparată
separat. Nu e în scope-ul pilotului Madrid, dar merită atenția ta.

## Finalizat parțial — M5 (analytics, funnel, export agregat)

Autorizat 2026-08-16.

| Criteriu M5                                                                                   | Stare                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evenimente civice deja înregistrate (propuneri, deliberare, vot, mandat, acțiune, verificare) | **PASS — deja exista.** `civic_process_events` urmărea deja fiecare tranziție de etapă, dinainte de această sesiune                                                                                                                                              |
| Export agregat funcțional                                                                     | **PASS, cod nou.** `GET /v1/platform/pilot/funnel-export` — doar numere (mărimea cohortei, confirmări, propuneri, voturi, mandate, verificări), zero identificatori de cont. Testat explicit că ID-urile de cont nu apar niciunde în răspuns. `town-api@ad4b1e4` |
| Fără tracking publicitar extern                                                               | **PASS.** Totul rămâne în Postgres-ul existent, niciun serviciu extern adăugat                                                                                                                                                                                   |
| Consimțământ separat pentru analiza agregată, capturat explicit                               | **NEFĂCUT, intenționat.** Nu există niciun concept de „consimțământ" nicăieri în cod. Scrierea lui (text, unde apare, cum se acceptă) e o decizie a ta, nu tehnică — nu am inventat-o                                                                            |

**De ce am lăsat consimțământul neconstruit:** ai spus tu însuți, la punctul 8
din strategia originală, că tu aprobi mesajul TOWN Madrid și tot ce ține de
felul în care oamenii sunt informați/își dau acordul. Aș fi putut scrie un
checkbox generic, dar ar fi fost exact genul de decizie de conținut/produs
pe care am promis să nu o iau eu în locul tău.

## Finalizat — M6 (invitații, linkuri directe)

Autorizat și închis 2026-08-16.

| Criteriu M6                                   | Stare                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Mesajul de invitație aprobat de tine explicit | **PASS** — text complet în `PILOT_MADRID_DECISIONS.md`, aprobat 2026-08-16                                                 |
| Link direct funcțional per semnal             | **PASS** — `#/feed/<slug>` sare direct la semnalul respectiv, fără să afecteze nicio altă rută. `town-public@05e3706`      |
| Fără date/participanți simulați               | **PASS** — nimic trimis, niciun participant simulat; mesajul are încă placeholder de link, nu unul funcțional de producție |

**Linkuri testabile chiar acum, pe Staging** (tu poți verifica, eu nu am
acces la un browser real din acest mediu):

- `https://madrid-staging.towncivic.org/#/feed/madrid-signal-1` — Calle Argumosa
- `https://madrid-staging.towncivic.org/#/feed/madrid-signal-2` — Parque Tierno Galván
- `https://madrid-staging.towncivic.org/#/feed/madrid-signal-3` — Puerta de Alcalá / Retiro

Placeholder-ul din mesajul WhatsApp aprobat rămâne neînlocuit până există
`madrid.towncivic.org` (producție, M9) — link-urile de mai sus sunt pentru
Staging, nu pentru trimis prietenilor încă.

## Finalizat — M7 (pagina publică de rezultat)

Autorizat și închis 2026-08-16. **Nicio linie de cod scrisă** — totul exista
deja, verificat direct în cod, nu presupus.

| Criteriu M7                                     | Stare                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rezultat arhivat afișat fără autentificare      | **PASS — deja exista.** `GET /v1/signals/:signalId/civic-process/verification` nu are `security:` în schemă                                                       |
| Dovezi vizibile                                 | **PASS — deja exista.** Jurnal complet de dovezi, tally delivered/not-delivered, propunere câștigătoare                                                           |
| Niciun rezultat inventat pentru proces nedecis  | **PASS — deja exista.** `outcome: verification?.outcome ?? null`; dispută neajunsă la prag „escaladează vizibil", nu se auto-rezolvă (comentariu explicit în cod) |
| Randare pe frontend, fără gate de autentificare | **PASS — deja exista.** `openSignalDetail()` nu verifică nicio sesiune; panoul de verificare se randează automat la etapele action/verification/archived          |

**De reținut, nu de reparat:** numele afișat lângă dovezi/propuneri e numele
real pe care autorul îl completează explicit la publicare
(`request.body.realName`, câmp obligatoriu) — design dinainte de pilot,
nu ceva introdus de mine. Relevant pentru tine, dat fiind că pagina e
publică.

## Aproape închis — M8 (E2E, securitate, capacitate, QA vizual)

Autorizat 2026-08-16.

| Criteriu M8                                           | Stare                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test dedicat CORS pe originul Madrid                  | **PASS, real, rulat.** `test/ops.cors.test.ts` — 3 teste noi, instanță Fastify reală, exact cele 3 origini confirmate live pe Staging. 17/17 verzi                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Test dedicat CSRF pe originul Madrid                  | **PASS, real, rulat.** `test/ceremony.csrf.test.ts` (fișier nou) — 8/8 verzi. Nu exista niciun test dedicat pentru `assertWebCookieCsrf` înainte                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Test dedicat WebAuthn pe originul Madrid              | **PASS, real, rulat.** `test/ops.staging-railway-origins.test.ts` extins — 16/16 verzi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Test de capacitate comparabil cu `loadtest/README.md` | **PASS, rulare proaspătă.** Declanșat din această sesiune (`workflow_dispatch`, commit `0ad0db4`): **10.817 cereri, 0% eșecuri**, toate pragurile de latență respectate (p95 sub 182ms, praguri 500-800ms), 100 utilizatori concurenți susținuți 3m30s. Consistent cu rularea anterioară din `STATUS.md` general (10.591 cereri)                                                                                                                                                                                                                                                                        |
| Suită E2E/integrare verde                             | **PASS, verificat pe bază de date reală, prima oară în această sesiune.** Am pornit Postgres local (nu exista până acum în această sesiune) și am rulat suita completă de integrare — 82 fișiere. 7 fișiere au eșuat inițial cu erori de conexiune/tabelă lipsă imediat după migrare; verificate izolat, toate 7 trec curat — confirmat artefact de concurență din rularea unui singur proces lung (~7 min) cu resetări repetate de schemă, nicio legătură cu Madrid (`grep pilot_cohort` → un singur rezultat, testul meu, verde). Testele mele noi de M4/M5 (`platform.api.test.ts`) trec real: 16/16 |
| Migrarea 0059 verificată pe bază de date reală        | **PASS, nou.** Aplicată cu succes pe Postgres local — tabela `pilot_cohort_members` există genuine. A scos la iveală 5 fișiere de test cu lista de tabele hardcodată, neactualizată de la M4 (nu puteam prinde asta fără bază de date) — reparate și verificate, toate 17 teste (5 fișiere) verzi izolat                                                                                                                                                                                                                                                                                                |
| QA vizual mobil + desktop, aprobat personal de tine   | **PASS, real, confirmat de tine 2026-08-16.** Ai găsit bug-ul real (vezi mai jos), iar după fix + deploy ai testat explicit ambele — desktop și mobil — și ambele arată ok: cele 3 semnale vizibile, se deschid                                                                                                                                                                                                                                                                                                                                                                                         |
| Suită E2E Playwright completă (browser real)          | **NEFĂCUT.** Configurarea locală (chei WebAuthn, email, sesiune, ~15 variabile) ar fi cerut efort disproporționat față de timpul rămas — semnalat clar, nu ascuns, nu simulat. Singurul criteriu M8 rămas deschis                                                                                                                                                                                                                                                                                                                                                                                       |

### Bug real, găsit de QA-ul tău — reparat și acum live

Ai deschis `madrid-staging.towncivic.org/#/feed` și ai văzut „No live signals
right now" / „Couldn't reach TOWN — try again later" în loc de cele 3
semnale.

**Cauză confirmată în cod:** `api-base.js` nu recunoștea
`madrid-staging.towncivic.org` ca hostname de Staging. Cădea pe
presupunerea implicită de producție, deci fiecare cerere se ducea la
`api.towncivic.org` cu `Origin: https://madrid-staging.towncivic.org` —
respinsă de blocajul CORS de-un-singur-origin al producției (găsit încă din
M0/M2). Browserul vedea asta ca o eroare de rețea.

`madrid-pilot-host.js` (M2) bloca deja conținutul pe Madrid, dar nu era
niciodată legat de rutarea host→API din `api-base.js` — sunt două fișiere
diferite, iar golul a căzut exact între ele.

**Reparat:** `town-public@a4ecbfa`. 6 teste noi (33/33 total în
`test-api-base.js`), toate testele conexe re-rulate, curate.

**Deploy-uit — autorizat explicit de tine 2026-08-16.** PR
[#136](https://github.com/michaeltofan/town-public/pull/136) (fast-forward
curat peste `main`, fără conflicte), merge-uit
`town-public@9ec7bab74b17905e44dcf01da12441cbb5683f6e`. `town-public-staging`
pe Railway are auto-deploy pe push la `main` (`branch: "main"` în
configurația serviciului) — build declanșat automat, `SUCCESS`, finalizat
2026-08-16T08:11:44Z, servește cereri fără erori confirmat din log-urile
de deploy live.

**A doua verificare — CI real a picat, reparat.** Imediat după merge, E2E-ul
real de pe `main` a picat (`town-public` runs
[#146](https://github.com/michaeltofan/town-public/actions/runs/31972585680)/[#147](https://github.com/michaeltofan/town-public/actions/runs/31972589521)).
Cauză confirmată: schimbarea M2 la `PRODUCT_ONLY_CITY_ORDER` (gate de
hostname Madrid) a rescris exact linia pe care un test vechi
(`scripts/test-etapa3-member-journey.js`) o verifica ca string literal —
invariantul verificat de test tot ținea, doar forma sursei se schimbase.
Reprodus local, reparat, toate cele 19 scripturi din pasul „Static smoke"
al CI-ului rulate local în aceeași ordine, toate curate. PR
[#137](https://github.com/michaeltofan/town-public/pull/137) merge-uit,
`town-public@8f9bd4fdfa3a414585c7819432aec329915404e6`. CI real re-rulat pe
`main` (run #149) — verificat direct, nu presupus: **SUCCESS**. Railway a
redeploy-uit automat peste noul commit — deployment nou `SUCCESS`,
finalizat 2026-08-16T21:16:40Z, a înlocuit deployment-ul anterior.

**Confirmat de tine, real, 2026-08-16:** cele 3 semnale sunt vizibile pe
`madrid-staging.towncivic.org` și se deschid. Acesta e singurul tip de
verificare care închide cu adevărat acest bug — nu deploy-ul reușit, nu
CI-ul verde, ci tu uitându-te la pagină. Bug-ul e închis.

## Blocat / necesită decizia ta

- Textul și mecanismul exact de consimțământ pentru analiza agregată
  (M5) — fără el, exportul există tehnic, dar nu poate fi folosit public
  conform propriului tău criteriu.
- Suita E2E Playwright completă (browser real) — decizi dacă merită o
  sesiune dedicată doar pentru configurarea mediului local, sau rămâne
  acoperită de CI la următorul merge.
- Locul unde va fi ancorat accesul de 90 de zile (`accessUntil` vs. un flux
  nou de Stripe) — **decis: `accessUntil`, fără Stripe** (vezi tabelul de mai sus).
- `STATUS.md` (general, nu pilot) nu reflectă încă succesul din 13 aug. al
  restore drill-ului — recomand actualizare înainte de a considera gate-ul
  de stabilizare complet închis.
- Poze/video reale pentru cele 3 semnale Madrid, de la contactele tale —
  provizoriu acoperit doar de link Google Maps (vezi mai sus).
- Golul de snapshot-uri drizzle (0014–0058) — decizi tu dacă merită o
  trecere separată de reparat, în afara pilotului Madrid.

## M9 — autorizat la nivel de etapă, 2026-08-17, execuție nedefinită încă

Gate-ul de stabilizare (`PILOT_MADRID_MASTER_PLAN.md`) e închis — restore
atestat real, „zero defecte critice" trecut printr-o decizie conștientă a
lui Mihail, nu o verificare curată. Vezi `PILOT_MADRID_DECISIONS.md`.

**Important, per propriul plan al lui Mihail:** spre deosebire de M2–M8,
M9 nu are în `PILOT_MADRID_MASTER_PLAN.md` nicio listă de fișiere sau
criterii PASS/FAIL — doar propoziția „Autorizare separată, obligatorie."
Formularul de autorizare exclude explicit merge/deploy/Production „decât
dacă sunt menționate explicit", iar planul spune separat: „Merge și deploy
se autorizează separat, după verificarea dovezilor." Autorizarea de etapă
primită („trec mai departe cu M9") nu acoperă deci nicio acțiune concretă
asupra Production — urmează un pas separat de a stabili cu Mihail scopul
tehnic exact înainte de orice atingere de Production.

M10–M11 — nicio autorizare primită încă.

M8 rămâne „aproape închis", nu „finalizat" — QA vizual real e confirmat
(desktop + mobil); singurul rest e suita E2E Playwright completă,
opțională, nu blocantă în sine.

## Production — pasul „domeniu" (2026-08-17)

- `madrid.towncivic.org` creat pe `town-public` producție (Railway). DNS
  rezolvat automat, confirmat direct (`socket.gethostbyname_ex` →
  `ehk1fgba.up.railway.app` → `69.46.46.77`), fără nicio acțiune manuală —
  la fel ca la M2. Verificare HTTPS live blocată de proxy-ul acestui mediu,
  limitare de mediu, nu problemă reală.
- `WEBAUTHN_ALLOWED_ORIGINS` pe `town-api` producție extins de Mihail cu
  `https://madrid.towncivic.org`, verificat înainte că formatul nu are
  spații (parserul e strict, ar fi aruncat eroare la boot).

## Incident real, 2026-08-17 — salvarea variabilei a declanșat un deploy neintenționat

- Salvarea variabilei prin „Deploy Changes" în dashboard-ul Railway a
  declanșat un build nativ, direct din `main`, pe `town-api` **producție**
  — nu doar o repornire cu variabila nouă. Asta a inclus tot codul Madrid,
  migrarea 0059 inclusă.
- **Migrarea 0059 s-a aplicat cu succes pe baza de date de producție reală**
  (`Migrations applied successfully`, confirmat din log-ul de deploy),
  fără autorizare separată explicită pentru acest pas anume — efect
  secundar neintenționat, nu o acțiune directă a agentului.
- Aplicația nouă a picat imediat după la pornire: `RAILWAY_GIT_COMMIT_SHA
and APP_COMMIT_SHA must match exactly when both are set` — un build nativ
  (declanșat din dashboard) setează automat `RAILWAY_GIT_COMMIT_SHA`, dar
  `APP_COMMIT_SHA` rămâne la valoarea setată ultima dată de job-ul CI
  dedicat, nerulat pe producție din 11 aug. Deploy `FAILED`, Railway n-a
  comutat traficul — versiunea veche (`ffabf885`, 11 aug., precede tot
  codul Madrid) a rămas activă. Verificat direct din log-urile HTTP live
  Railway (nu presupus): cereri reale, 200 OK, pe `api.towncivic.org` și
  `towncivic.org`, de pe dispozitive reale, în timp real.
- **Consecință reală, confirmată extern:** aplicația veche așteaptă exact
  59 de migrări; baza de date are acum 60. `GET /health/ready` pe
  `api.towncivic.org` → **503**, confirmat prin rularea reală a
  `.github/workflows/health-alert.yml` (acces la internet real, extern
  acestui mediu) — `production /health/ready -> HTTP 503`. Trafic de
  business neafectat (confirmat separat), dar aplicația se declară pe sine
  „not ready".
- **Bug separat, preexistent, găsit pe drum:** pasul care ar fi trebuit să
  deschidă automat un issue GitHub la acest eșec a picat el însuși, cu o
  eroare de sintaxă JS în `health-alert.yml` (backtick din URL în conflict
  cu template literal-ul din jur) — alerta reală n-a ajuns nicăieri automat.
  Nu are legătură cu Madrid; de reparat separat.
- **A doua descoperire, în timpul reparației:** prima încercare de deploy
  prin pipeline-ul CI (`workflow_dispatch`, run
  [#649](https://github.com/michaeltofan/town-api/actions/runs/32013607335))
  a fost anulată — agentul a merge-uit alt PR pe `main` cât timp acel
  deploy rula, iar `concurrency: cancel-in-progress: true` din `ci.yml`
  (același grup pentru orice run pe `refs/heads/main`) l-a omorât.
  Nicio pagubă reală — anularea a prins job-ul „quality" înainte de orice
  atingere de Production, verificat direct din `list_workflow_jobs`
  (toate cele 3 job-uri: `cancelled`). Redeclanșat curat, run
  [#652](https://github.com/michaeltofan/town-api/actions/runs/32014238622).
- **A treia descoperire:** run #652 a trecut de job-ul „quality" complet,
  dar a picat la „Deploy town-api (production)" cu o eroare diferită:
  `Invalid environment configuration: production WEBAUTHN_ALLOWED_ORIGINS
must be exactly https://towncivic.org`. Cauză confirmată în cod,
  `assertProductionWebAuthnPolicy()` —
  `src/ceremony/passkey-registration/config.ts:188-199`: producția
  acceptă **exact un singur origin**, hardcodat la
  `PRODUCTION_ALLOWED_ORIGIN = 'https://towncivic.org'`
  (`policy.ts:17`). Adăugarea lui `madrid.towncivic.org` la
  `WEBAUTHN_ALLOWED_ORIGINS` pe producție (făcută mai devreme azi) e
  incompatibilă cu acest lock, prin design — nu un bug. Verificat doar
  sintaxa (fără spații) la momentul acelei schimbări, nu și această
  regulă semantică, deși documentată încă din raportul M0
  (`PILOT_MADRID_EVIDENCE.md`, secțiunea 2).
- **Reparație finală, autorizată de Mihail:** `WEBAUTHN_ALLOWED_ORIGINS`
  readusă la exact `https://towncivic.org` (`mcp__Railway__set-variables`,
  `skipDeploys: true`, ca să nu declanșeze alt deploy necontrolat),
  verificat direct din `list-deployments` că n-a pornit niciun deploy
  nou. Deploy redeclanșat curat prin pipeline-ul CI, run
  [#653](https://github.com/michaeltofan/town-api/actions/runs/32015956517)
  — **SUCCESS complet**, inclusiv „Smoke test deployed production”.
  Deployment Railway nou (`10649101-7159-40b3-9136-586172d751c5`)
  `SUCCESS`, a înlocuit versiunea veche.
- **Verificare finală, din 4 surse independente, externe acestui mediu:**
  `.github/workflows/health-alert.yml` declanșat manual, run
  [#176](https://github.com/michaeltofan/town-api/actions/runs/32017028045) —
  `production /health/live -> 200`, `production /health/ready -> 200`,
  `staging /health/live -> 200`, `staging /health/ready -> 200`. Pasul de
  închidere automată a incidentului (reparat mai devreme) a funcționat
  corect, fără eroare.

**Concluzie parțială:** codul Madrid M4/M5 rulează pe producție, sincronizat
cu baza de date deja migrată.

## Lock de un-singur-origin relaxat, `madrid.towncivic.org` acum permis (2026-08-17)

Mihail a semnalat direct, cu dovadă reală: `madrid-staging.towncivic.org`
arăta cele 3 semnale, dar `madrid.towncivic.org` nu — pentru că nici
fix-ul de backend, nici codul de site pentru Madrid nu ajunseseră încă pe
producție.

- **Fix de backend, cod revizuit** (nu doar o variabilă):
  `assertProductionWebAuthnPolicy()` cerea exact un singur origin în
  producție; CORS/CSRF citesc aceeași variabilă — nu exista nicio
  configurație care să lase deschisă atât autentificarea sigură pe
  `towncivic.org`, cât și citirea publică de pe `madrid.towncivic.org`.
  Rezolvat printr-o listă explicită, hardcodată,
  `PRODUCTION_ALLOWED_ORIGINS`, nu o relaxare generică. Detalii tehnice
  complete: `PILOT_MADRID_EVIDENCE.md`.
- Verificat: 590 teste (suita implicită) + 544 teste (suita de integrare)
  - 4 teste noi dedicate, toate verzi pe Postgres real, înainte de push.
- PR [town-api#167](https://github.com/michaeltofan/town-api/pull/167)
  merge-uit, deploy pe producție prin pipeline-ul CI, run
  [#656](https://github.com/michaeltofan/town-api/actions/runs/32019416621) —
  SUCCESS complet. Verificare externă, `health-alert.yml` run
  [#178](https://github.com/michaeltofan/town-api/actions/runs/32021168717) —
  SUCCESS.
- `town-public` (codul de site care blochează experiența pe Madrid) era
  deja pe `main`, testat, live pe Staging — dar niciodată deploy-uit pe
  producție. Deploy declanșat prin pipeline-ul CI propriu, run
  [#150](https://github.com/michaeltofan/town-public/actions/runs/32021226804) —
  SUCCESS complet (`smoke-and-e2e`, `staging-account-enrollment`, „Deploy
  to production (Railway)" — toate verzi). Deployment Railway nou
  (`bbc923c1-00be-4ee8-80a8-d6d2d437fd02`) `SUCCESS`, a înlocuit
  versiunea din 12 aug.

**Amândouă bucățile sunt acum pe producție, verificat din Railway și CI —
nu doar cod merge-uit, deploy-uri reale, confirmate.** Ce n-am verificat
și nu pot verifica din acest mediu: aspectul real al paginii
`madrid.towncivic.org/#/feed`. Rămâne la Mihail confirmarea vizuală
finală.

Ultimul commit relevant pe `main`: `e69e6b0` (town-api, conține tot codul
Madrid M4/M5 + fix-ul de origini multiple, deploy-uit real pe producție),
`8f9bd4f` (town-public, conține tot codul Madrid M2/M6, deploy-uit real
pe producție).

## M9 — confirmarea vizuală a picat, două cauze reale găsite

Confirmarea vizuală a lui Mihail a contrazis direct așteptarea:
`madrid.towncivic.org/#/feed` arăta 67 de semnale din toate orașele, iar
singurul semnal Madrid vizibil avea încă eticheta veche „Vallecas".
Diagnoza completă, cu dovezi directe, e în
`PILOT_MADRID_EVIDENCE.md` — pe scurt, două cauze independente, niciuna
în logica de pilot în sine:

1. **`script.js` vechi, din cache-ul browserului.** Lock-ul Madrid a ajuns
   în `script.js` și `api-base.js` fără să li se schimbe cheia `?v=` din
   `index.html`, deci browserele care mai deschiseseră acel origin înainte
   au reluat bundle-ul pre-pilot din cache. Logurile HTTP reale Railway
   arată `GET /madrid-pilot-host.js` `200`/`304` fără niciun
   `GET /script.js` în aceleași încărcări de pagină. Fix în
   `town-public@b317317` (chei `?v=madrid-pilot-1`), toate cele 19
   verificări statice din CI trecute local.
2. **Baza de date de producție populată înainte de corectura de conținut.**
   Ultima rulare reușită a `town-api-seed-production` e din
   `2026-08-16T17:59:29Z`, iar corectura „Legazpi/Arganzuela, not Vallecas"
   (`3c0bdbd`) e din `2026-08-16T19:13:47Z` — deci seed-ul nu a rulat
   niciodată cu conținutul corect.

Ce lipsește, ambele fiind acțiuni de Producție care așteaptă autorizare
explicită separată:

- [x] merge `town-public@b317317` în `main` (→ `4f07671`) + deploy de
      producție prin `e2e.yml` cu `deploy_production: true`, run
      [#153](https://github.com/michaeltofan/town-public/actions/runs/32023048195)
      `success`, deployment Railway `371845e6` `SUCCESS` la `11:04:32Z`
- [x] re-rularea `town-api-seed-production` pe baza de date de producție,
      deployment `71d150ea` `SUCCESS` la `11:06:17Z`, build pe `e69e6b0`
      (include `3c0bdbd`), log real:
      `Foundation seed applied: communities=22 signals=66`

Ambele acțiuni au fost autorizate explicit și separat de Mihail înainte de
execuție. Detaliile complete, inclusiv capcana evitată (un push în `main` pe
`town-api` ar fi declanșat un deploy de producție al API-ului plus migrații,
neautorizate) sunt în `PILOT_MADRID_EVIDENCE.md`.

Rămâne un singur lucru: **confirmarea vizuală a lui Mihail** pe
`madrid.towncivic.org/#/feed`, cu reload forțat — cache-ul vechi din browser
e chiar cauza 1, deci un reload obișnuit poate încă servi bundle-ul vechi
până expiră.
