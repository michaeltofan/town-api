# Pilot Madrid — jurnal de decizii

Fiecare rând: cine a decis, ce, când. Nicio decizie nu e validă dacă nu e
aici.

| Dată | Decizie | Aprobat de |
|---|---|---|
| 2026-08-16 | M0 (inventar read-only) autorizat și acceptat | Mihail |
| 2026-08-16 | Documentele PILOT_MADRID_* locuiesc în `town-api`, la rădăcină, lângă `STATUS.md` | Mihail |
| 2026-08-16 | M1 (plan, metrici, criterii) autorizat | Mihail |
| 2026-08-16 | M2 autorizat | Mihail |
| 2026-08-16 | Hostname Staging: `madrid-staging.towncivic.org` (CNAME apărut automat, Railway administrează DNS-ul) | Mihail |
| 2026-08-16 | `WEBAUTHN_ALLOWED_ORIGINS` pe `town-api-staging` extins manual de Mihail din Railway dashboard, cu originul Madrid adăugat la coadă | Mihail |
| 2026-08-16 | M2 declarat închis — toate criteriile PASS, unul (CORS live) verificat pe cod și deploy, nu prin cerere HTTP reală (imposibil din acest mediu, vezi PILOT_MADRID_EVIDENCE.md) | Mihail |
| 2026-08-16 | M3 autorizat | Mihail |
| 2026-08-16 | Eticheta Vallecas → corectată la Legazpi/Arganzuela, condiționat de „100% sigur"; verificat pe 3 surse independente înainte de aplicare | Mihail |
| 2026-08-16 | Proveniență semnale Madrid: link Google Maps (provizoriu), ca la Decide Madrid; poze/video reale rămân de adăugat separat | Mihail |
| 2026-08-16 | M3 declarat închis | Mihail |
| 2026-08-16 | M4 autorizat | Mihail |
| 2026-08-16 | Model acces 90 zile: `accessUntil`, fără Stripe — confirmat, deja existent în cod | Mihail |
| 2026-08-16 | Cohorta Madrid: tabelă nouă `pilot_cohort_members`, separată de membership-ul general | Mihail |
| 2026-08-16 | M4 declarat închis — cod complet, testat; migrarea 0059 NU a fost rulată pe nicio bază de date, se aplică automat la următorul deploy autorizat separat | Mihail |
| 2026-08-16 | M5 autorizat | Mihail |
| 2026-08-16 | Consimțământ pentru analiza agregată — decis să NU fie construit acum; e decizie de conținut a lui Mihail, nu tehnică | Mihail |
| 2026-08-16 | M5 declarat parțial închis — export agregat funcțional și testat, consimțământul rămâne blocaj deschis | Mihail |
| 2026-08-16 | Mesaj de invitație WhatsApp (M6) aprobat, text integral mai jos | Mihail |
| 2026-08-16 | Partea tehnică a M6 (linkuri directe per semnal) autorizată | Mihail |
| 2026-08-16 | M6 declarat închis — mesaj aprobat + linkuri `#/feed/<slug>` funcționale pe Staging; placeholder-ul din mesaj rămâne neînlocuit până la M9 | Mihail |
| 2026-08-16 | M7 autorizat | Mihail |
| 2026-08-16 | M7 declarat închis — verificat deja construit complet (API public + randare frontend fără gate de autentificare), zero cod nou scris | Mihail |
| 2026-08-16 | M8 autorizat | Mihail |
| 2026-08-16 | Test de capacitate declanșat manual pe Staging din această sesiune (workflow_dispatch, safe by design) | Mihail |
| 2026-08-16 | M8 declarat „parțial" — CORS/CSRF/WebAuthn/capacitate/migrare verificate real pe cod care rulează; QA vizual și E2E Playwright rămân blocaje deschise, nu bifate artificial | Mihail |
| 2026-08-16 | Bug real găsit de QA vizual (madrid-staging arăta „Couldn't reach TOWN") — cauză confirmată în `api-base.js`, reparat, `town-public@a4ecbfa`, nu încă deploy-uit | Mihail |
| 2026-08-16 | Merge + deploy pentru `town-public` autorizat — PR #136 merge-uit (`9ec7bab`), Railway a deploy-uit automat pe `town-public-staging` din `main`, `SUCCESS`, fix-ul e live | Mihail |
| 2026-08-16 | CI real pe `main` a picat imediat după merge (regresie de test, nu de produs) — reparat, PR #137 merge-uit (`8f9bd4f`), CI real re-verificat SUCCESS, Railway redeploy-uit automat | Agent (sub mandatul „drive to green" al PR-urilor proprii, fără autorizare separată — vezi EVIDENCE.md) |
| 2026-08-16 | Bug-ul `api-base.js` declarat închis — Mihail a confirmat vizual, real, pe `madrid-staging.towncivic.org`: cele 3 semnale sunt vizibile și se deschid | Mihail |
| 2026-08-16 | QA vizual M8 (desktop + mobil) declarat trecut — Mihail a testat explicit ambele, ambele arată ok | Mihail |

## Mesajul de invitație WhatsApp — aprobat 2026-08-16

Text final (spaniolă, ce primesc destinatarii):

> Hola [Nombre] 👋
>
> Estoy probando TOWN, una app para señalar problemas reales del barrio y
> darles seguimiento — cosas como la acera rota en la calle Argumosa o las
> farolas apagadas junto al parque Tierno Galván.
>
> Te invito a probarla en Madrid, acceso gratis los primeros 90 días. Somos
> muy pocos todavía — es justo por eso que tu opinión sincera me sirve más
> que nada.
>
> [enlace — pendiente de lanzamiento]
>
> ¿Te apuntas?

Placeholder-ul `[enlace — pendiente de lanzamiento]` rămâne neînlocuit până
`madrid.towncivic.org` (producție) există — vezi M9. Trimiterea efectivă nu
are loc din acest mediu; textul e doar aprobat, nu expediat.

## Decizii deschise (nu s-au luat încă)

- Textul și mecanismul de consimțământ pentru analiza agregată (M5) —
  fără el, exportul nu poate fi folosit public conform criteriului tău.
- Poze/video reale ale celor 3 probleme civice din Madrid, de la contactele
  lui Mihail — proveniența actuală (Google Maps) confirmă doar locația, nu
  problema curentă. Necesar înainte de M8/M10.
- Confirmarea personală a atestării de restore din consola `ops_admin`,
  înainte ca gate-ul de stabilizare să fie considerat complet închis.
- Membrii cu home-city în altă comunitate decât Madrid mai văd și acea
  comunitate pe hostname-ul Madrid — rămâne neschimbat de M4, nu a fost
  cerut explicit; de revizitat dacă devine relevant pentru cohorta reală.
- Confirmare live opțională a CORS printr-o cerere HTTP reală peste
  internet (comanda curl din PILOT_MADRID_EVIDENCE.md) — de la M8,
  comportamentul e deja verificat printr-o instanță Fastify reală rulată
  local, nu doar trasat pe cod; rămâne opțională doar certitudinea 100%
  peste rețea.
- Golul de snapshot-uri drizzle (0014–0058), găsit în timpul M4 — decizi
  dacă merită o trecere separată de reparat, în afara pilotului Madrid.
- Autorizarea de merge+deploy pentru `town-api`, care va aplica efectiv
  migrarea 0059 pe Staging (și apoi Production).
- Suita E2E Playwright completă cu browser real (M8) — necesită o
  configurare locală de mediu (~15 variabile) care nu a fost făcută în
  această trecere; decizi dacă merită o sesiune dedicată.
