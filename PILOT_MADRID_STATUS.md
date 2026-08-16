# Pilot Madrid — status curent

Actualizat: 2026-08-16. Regula STATUS.md generală se aplică și aici: dacă nu
e în `main`, nu e real.

## Finalizat

- **M0 — inventar read-only.** Raport complet livrat, verificat pe
  `town-api@0ad0db4` / `town-public@9eac1b3` (= `main` real, fără drift).
  Zero modificări de cod în această etapă. Detalii: `PILOT_MADRID_EVIDENCE.md`.
- **M1 — planul, metricile, criteriile.** Cele 4 documente, aprobate.

## Activ — M2, parțial (Staging)

Autorizat 2026-08-16. Stare reală pe fiecare criteriu din master plan:

| Criteriu M2 | Stare |
|---|---|
| Domeniu custom `madrid-staging.towncivic.org` în Railway | **PASS** — creat; Railway administrează DNS-ul pentru `towncivic.org` nativ, CNAME apărut automat, fără acțiune manuală necesară |
| Feed arată doar cele 3 semnale Madrid pe acel hostname | **PASS** — `town-public@8476e01`, `madrid-pilot-host.js` + o linie în `script.js` (`PRODUCT_ONLY_CITY_ORDER`), teste noi + suita existentă relevantă verde, zero regresie |
| Selector țară/oraș ascuns complet | **Parțial** — feed-ul implicit arată doar Madrid; ecranele dedicate de selecție (`view-country`/`view-city`) nu au fost încă blocate explicit pe acest hostname |
| Pornire Staging fără eroare de config WebAuthn (origin nou permis) | **PASS** — verificat direct din log-urile de deploy (`80d2952c`, commit `0ad0db4`): „Server listening”, `/health/ready` → 200, zero eroare de configurare, cu `WEBAUTHN_ALLOWED_ORIGINS` extins de Mihail (valoare adăugată manual din Railway dashboard, cu valoarea veche păstrată) |
| CSRF/CORS/passkey verzi pe originul nou | **Parțial** — aceeași variabilă alimentează toate trei (cod verificat în M0), pornirea confirmă că originul e acceptat de validare; un test funcțional live (cerere reală cu Origin: madrid-staging) nu a fost rulat încă |
| Niciun test existent nu regresează | **Parțial** — 4 teste node relevante + verificare de sintaxă, verzi; suita completă E2E (Playwright, cere servicii pornite) nu a fost rulată în această trecere |

### Rezolvat — WEBAUTHN_ALLOWED_ORIGINS

Mihail a citit valoarea curentă din Railway dashboard și a adăugat originul
nou manual (fără să șteargă ce era acolo), evitând riscul de suprascriere
pe care sesiunea nu-l putea verifica singură. Valoare finală, confirmată:
`https://towncivic.org,https://town-public-staging-staging.up.railway.app,https://madrid-staging.towncivic.org`.
Deploy verificat SUCCESS, pornire curată.
   (`town-api-staging` → Variables → `WEBAUTHN_ALLOWED_ORIGINS`).

### Acțiune cerută de la tine, separat

Adaugă la furnizorul de DNS: `madrid-staging.towncivic.org` → CNAME →
`xey4zpuf.up.railway.app`. Fără el, certificatul rămâne în „validating”.

## Blocat / necesită decizia ta

- Eticheta Vallecas pe semnalul „Farolas Parque Tierno Galván” — confirmată
  eronată în cod (`foundation-content.ts:2093`), corect ar fi
  Legazpi/Arganzuela. Nu a fost corectată — decizia îți aparține (M3).
- Locul unde va fi ancorat accesul de 90 de zile (`accessUntil` vs. un flux
  nou de Stripe) — recomandare dată în master plan, decizie finală a ta.
- `STATUS.md` (general, nu pilot) nu reflectă încă succesul din 13 aug. al
  restore drill-ului — recomand actualizare înainte de a considera gate-ul
  de stabilizare complet închis.
- Ecranele dedicate `view-country`/`view-city` nu sunt încă blocate pe
  hostname-ul Madrid (vezi tabelul de mai sus).

## Neatinsă

M3–M11 — nicio autorizare primită încă.

## Production

Neatinsă de pilot. Ultimul commit relevant pe `main`: `0ad0db4` (town-api),
`9eac1b3` (town-public).
