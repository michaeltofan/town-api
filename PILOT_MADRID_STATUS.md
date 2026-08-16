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

## Finalizat — M2 (Staging)

Autorizat și închis 2026-08-16. Stare reală pe fiecare criteriu din master plan:

| Criteriu M2 | Stare |
|---|---|
| Domeniu custom `madrid-staging.towncivic.org` în Railway | **PASS** — creat; Railway administrează DNS-ul pentru `towncivic.org` nativ, CNAME apărut automat, fără acțiune manuală necesară |
| Feed arată doar cele 3 semnale Madrid pe acel hostname | **PASS** — `town-public@8476e01`, `madrid-pilot-host.js` + o linie în `script.js` (`PRODUCT_ONLY_CITY_ORDER`), teste noi + suita existentă relevantă verde, zero regresie |
| Selector țară/oraș ascuns complet | **PASS** — `town-public@f8de6ca`. Povestea „explorează alte orașe” (singurul punct de intrare spre `view-country`/`view-city` în modul product-only — confirmat prin trasarea codului din `go()`) nu mai e inserată în feed pe hostname-urile pilot Madrid; fără acel click, ecranele rămân inaccesibile |
| Pornire Staging fără eroare de config WebAuthn (origin nou permis) | **PASS** — verificat direct din log-urile de deploy (`80d2952c`, commit `0ad0db4`): „Server listening”, `/health/ready` → 200, zero eroare de configurare |
| CSRF/CORS/passkey verzi pe originul nou | **PASS, verificat pe cod, nu live** — `src/plugins/cors.ts` face un simplu `Set.has(requestOrigin)` pe exact lista din `WEBAUTHN_ALLOWED_ORIGINS`; pornirea reușită confirmă că originul Madrid e în acea listă. Test HTTP live nu a fost posibil — proxy-ul acestui mediu blochează explicit `api-staging.towncivic.org` și `madrid-staging.towncivic.org` (verificat prin `$HTTPS_PROXY/__agentproxy/status`, `connect_rejected`, nu presupunere) |
| Niciun test existent nu regresează | **Parțial** — 4 teste node relevante + verificare de sintaxă, verzi de fiecare dată; suita completă E2E (Playwright, cere servicii pornite) nu a fost rulată în această trecere |

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

| Criteriu M3 | Stare |
|---|---|
| Eticheta Vallecas corectată sau păstrată, cu decizie explicită | **PASS** — corectată la Legazpi/Arganzuela, verificat pe 3 surse independente (Ayuntamiento de Madrid, Wikipedia, HallaMadrid) înainte de schimbare. `town-api@3c0bdbd` |
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

| Criteriu M4 | Stare |
|---|---|
| Acces 90 zile prin `accessUntil`, fără Stripe | **PASS — deja exista.** `POST /v1/platform/memberships/grant` era deja complet funcțional, cu `source: 'admin'`, înainte de această etapă |
| Acordarea e auditată (cine, cui, când) | **PASS — deja exista.** Fiecare grant scrie în `platform_audit_events` (`membership_granted`) — mecanism generic, nu specific Madrid |
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

| Criteriu M5 | Stare |
|---|---|
| Evenimente civice deja înregistrate (propuneri, deliberare, vot, mandat, acțiune, verificare) | **PASS — deja exista.** `civic_process_events` urmărea deja fiecare tranziție de etapă, dinainte de această sesiune |
| Export agregat funcțional | **PASS, cod nou.** `GET /v1/platform/pilot/funnel-export` — doar numere (mărimea cohortei, confirmări, propuneri, voturi, mandate, verificări), zero identificatori de cont. Testat explicit că ID-urile de cont nu apar niciunde în răspuns. `town-api@ad4b1e4` |
| Fără tracking publicitar extern | **PASS.** Totul rămâne în Postgres-ul existent, niciun serviciu extern adăugat |
| Consimțământ separat pentru analiza agregată, capturat explicit | **NEFĂCUT, intenționat.** Nu există niciun concept de „consimțământ" nicăieri în cod. Scrierea lui (text, unde apare, cum se acceptă) e o decizie a ta, nu tehnică — nu am inventat-o |

**De ce am lăsat consimțământul neconstruit:** ai spus tu însuți, la punctul 8
din strategia originală, că tu aprobi mesajul TOWN Madrid și tot ce ține de
felul în care oamenii sunt informați/își dau acordul. Aș fi putut scrie un
checkbox generic, dar ar fi fost exact genul de decizie de conținut/produs
pe care am promis să nu o iau eu în locul tău.

## Blocat / necesită decizia ta

- Textul și mecanismul exact de consimțământ pentru analiza agregată
  (M5) — fără el, exportul există tehnic, dar nu poate fi folosit public
  conform propriului tău criteriu.
- Locul unde va fi ancorat accesul de 90 de zile (`accessUntil` vs. un flux
  nou de Stripe) — **decis: `accessUntil`, fără Stripe** (vezi tabelul de mai sus).
- `STATUS.md` (general, nu pilot) nu reflectă încă succesul din 13 aug. al
  restore drill-ului — recomand actualizare înainte de a considera gate-ul
  de stabilizare complet închis.
- Poze/video reale pentru cele 3 semnale Madrid, de la contactele tale —
  provizoriu acoperit doar de link Google Maps (vezi mai sus).
- Golul de snapshot-uri drizzle (0014–0058) — decizi tu dacă merită o
  trecere separată de reparat, în afara pilotului Madrid.

## Neatinsă

M6–M11 — nicio autorizare primită încă.

## Production

Neatinsă de pilot. Ultimul commit relevant pe `main`: `0ad0db4` (town-api),
`9eac1b3` (town-public).
