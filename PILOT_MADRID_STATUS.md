# Pilot Madrid — status curent

Actualizat: 2026-08-16. Regula STATUS.md generală se aplică și aici: dacă nu
e în `main`, nu e real.

## Finalizat

- **M0 — inventar read-only.** Raport complet livrat, verificat pe
  `town-api@0ad0db4` / `town-public@9eac1b3` (= `main` real, fără drift).
  Zero modificări de cod în această etapă. Detalii: `PILOT_MADRID_EVIDENCE.md`.

## Activ

- **M1 — planul, metricile, criteriile.** Acest set de 4 documente. Aștaptă
  aprobarea ta pe criteriile PASS/FAIL din `PILOT_MADRID_MASTER_PLAN.md`
  înainte ca M2 să poată fi autorizat.

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

M2–M11 — nicio autorizare primită încă.

## Production

Neatinsă de pilot. Ultimul commit relevant pe `main`: `0ad0db4` (town-api),
`9eac1b3` (town-public).
