# Pilot Madrid — status curent

Actualizat: 2026-08-16. Regula STATUS.md generală se aplică și aici: dacă nu
e în `main`, nu e real.

## Finalizat

- **M0 — inventar read-only.** Raport complet livrat, verificat pe
  `town-api@0ad0db4` / `town-public@9eac1b3` (= `main` real, fără drift).
  Zero modificări de cod în această etapă. Detalii: `PILOT_MADRID_EVIDENCE.md`.
- **M1 — planul, metricile, criteriile.** Cele 4 documente, aprobate.

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

## Blocat / necesită decizia ta

- Eticheta Vallecas pe semnalul „Farolas Parque Tierno Galván” — confirmată
  eronată în cod (`foundation-content.ts:2093`), corect ar fi
  Legazpi/Arganzuela. Nu a fost corectată — decizia îți aparține (M3).
- Locul unde va fi ancorat accesul de 90 de zile (`accessUntil` vs. un flux
  nou de Stripe) — recomandare dată în master plan, decizie finală a ta.
- `STATUS.md` (general, nu pilot) nu reflectă încă succesul din 13 aug. al
  restore drill-ului — recomand actualizare înainte de a considera gate-ul
  de stabilizare complet închis.

## Neatinsă

M3–M11 — nicio autorizare primită încă.

## Production

Neatinsă de pilot. Ultimul commit relevant pe `main`: `0ad0db4` (town-api),
`9eac1b3` (town-public).
