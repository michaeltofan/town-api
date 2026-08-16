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

## Decizii deschise (nu s-au luat încă)

- Poze/video reale ale celor 3 probleme civice din Madrid, de la contactele
  lui Mihail — proveniența actuală (Google Maps) confirmă doar locația, nu
  problema curentă. Necesar înainte de M8/M10.
- Modelul exact de acordare a accesului de 90 de zile (recomandare:
  `accessUntil`, fără Stripe) — de confirmat explicit.
- Confirmarea personală a atestării de restore din consola `ops_admin`,
  înainte ca gate-ul de stabilizare să fie considerat complet închis.
- Membrii cu home-city în altă comunitate decât Madrid mai văd și acea
  comunitate pe hostname-ul Madrid (comportament neschimbat de M2,
  identificat ca subiect pentru M4 — acces/cohortă).
- Confirmare live opțională a CORS (comanda curl din
  PILOT_MADRID_EVIDENCE.md), dacă vrei certitudinea 100% empirică.
