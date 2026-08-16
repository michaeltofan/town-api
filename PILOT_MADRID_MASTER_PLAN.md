# TOWN — Plan obligatoriu de execuție, Pilot Madrid

Sursă unică de adevăr pentru pilotul Madrid. O modificare care nu apare aici
și în `main` nu face parte din pilot — o conversație, un chat sau un mesaj nu
autorizează nimic.

Documente însoțitoare, aceeași locație:

- `PILOT_MADRID_STATUS.md` — ce e finalizat, activ sau blocat, chiar acum.
- `PILOT_MADRID_EVIDENCE.md` — dovezi: SHA-uri, fișiere, workflow runs, teste.
- `PILOT_MADRID_DECISIONS.md` — jurnal de decizii, cine a aprobat ce.

Ultima actualizare: 2026-08-16, pe baza raportului M0 (verificat pe
`town-api@0ad0db4`, `town-public@9eac1b3`, ambele = `main` real, fără drift).

## Regula centrală

O singură etapă e autorizată o dată. Autorizarea produce dovezi. Dovezile se
verifică. Numai după verificare se autorizează etapa următoare. Nicio
autorizare nu acoperă „tot pilotul Madrid” dintr-un mesaj.

## Scopul înghețat, până la finalul pilotului

- Un singur oraș: Madrid (`madrid-es` — comunitate deja existentă în
  `src/db/seeds/foundation-content.ts`).
- Un singur subdomeniu: `madrid.towncivic.org`.
- Aceleași `town-api` / `town-public` / bază de date TOWN. Niciun serviciu nou.
- Un singur proces civic principal, cel existent (`civic-process` →
  `civic-proposals` → `civic-deliberation` → `civic-voting` →
  `civic-mandate` → `civic-action` → `civic-verification`).
- Fără aplicații native — `town-safe-space-mobile` e exclus complet din pilot.
- Fără alte orașe, fără funcții decorative, fără schimbarea membership-ului
  general TOWN, fără date/participanți simulați.
- Fără dezvoltări cerute spontan într-o etapă activă — orice idee nouă intră
  în backlog, se discută după pilot.

## Gate de stabilizare — condiție pentru M9 (Production)

Conform regulii 3 din strategia originală, Production pentru Madrid nu se
autorizează cât timp gate-ul de stabilizare generală TOWN nu e închis. Stare
reală, verificată (vezi `PILOT_MADRID_EVIDENCE.md` pentru detalii):

| Element | Stare |
|---|---|
| Restore verificat | **Parțial** — drill automat a rulat cu succes 13 aug. (după 7 eșecuri), dar `STATUS.md` nu e actualizat și atestarea din bază de date nu a fost confirmată independent |
| Capacitate verificată | **PASS** — 10.591 cereri, 0% eșecuri (`loadtest/README.md`) |
| Autentificare stabilă | **PASS** — password + passkey funcționale, testate |
| Enrollment stabil | Neverificat în M0, de reconfirmat în M1.5 dacă e nevoie |
| Emailuri funcționale | **PASS** ca mecanism, dar fără variantă în spaniolă |
| Flux civic complet | **PASS** — toate etapele (propunere→vot→mandat→acțiune→verificare) există și sunt testate |
| Monitorizare funcțională | **PASS** — health-alert.yml, poll la 15 min |
| Zero defecte critice cunoscute | Neconfirmat — necesită o trecere separată prin issues deschise |

**Recomandare:** M9 (Production) nu se autorizează până STATUS.md e actualizat
și atestarea de restore e confirmată direct din consola ops_admin de către
tine. Etapele M1–M8 (Staging și documentație) nu depind de acest gate.

## Etapele M0–M11

Fiecare etapă are: rezultat, fișiere vizate, criterii binare PASS/FAIL,
interdicții. Autorizarea foloseşte formularul de la finalul acestui document.

### M0 — Inventar read-only (FINALIZAT — vezi PILOT_MADRID_EVIDENCE.md)

Production: neatinsă. Rezultat: raport complet, fără nicio modificare de cod.

### M1 — Planul, metricile, criteriile acceptate (ÎN CURS — acest document)

Production: neatinsă. Fișiere: `PILOT_MADRID_MASTER_PLAN.md`,
`PILOT_MADRID_STATUS.md`, `PILOT_MADRID_EVIDENCE.md`,
`PILOT_MADRID_DECISIONS.md`, toate în `town-api`.

**PASS:** cele 4 documente există în `main`, cu criterii binare pentru
M2–M11, aprobate explicit de tine.
**FAIL:** orice etapă ulterioară fără criteriu binar definit aici.

### M2 — Experiența Madrid pe hostname, în Staging

Fișiere: `town-api/src/ceremony/passkey-registration/config.ts`,
`policy.ts` (extindere listă origini permise — vezi
`PILOT_MADRID_EVIDENCE.md` pt. mecanismul exact); `town-public/api-base.js`
(rutare hostname → oraș); domeniu custom nou în Railway pt. echivalentul de
staging al `madrid.towncivic.org`.

**PASS:**
- pornirea serviciului de Staging nu aruncă eroare de configurare WebAuthn;
- `GET /v1/communities/madrid-es/signals` returnează exact cele 3 semnale;
- pagina de Staging pe hostname-ul Madrid ascunde selectorul țară/oraș și
  fixează commitment-ul pe Madrid;
- niciun test existent (`test/`, `e2e/`) nu regresează;
- CSRF/CORS/passkey trec teste automate pe noul origin.

**FAIL:** orice test roșu, orice eroare de config la pornire, orice alt oraș
vizibil pe hostname-ul Madrid.

**Interdicții:** nicio atingere de Production; nicio migrare nouă fără
menționare explicită în autorizare.

### M3 — Conținut verificat, poze/video, proveniență

Fișiere: `town-api/src/db/seeds/foundation-content.ts` (cele 3 semnale,
inclusiv decizia ta pe eticheta Vallecas/Legazpi).

**PASS:** fiecare semnal are sursă/dovadă foto-video atașată și aprobată de
tine explicit (nu de agent); eticheta de zonă corectată sau păstrată printr-o
decizie explicită înregistrată în `PILOT_MADRID_DECISIONS.md`.
**FAIL:** orice semnal publicat fără aprobare explicită a ta pe conținut.

### M4 — Accesul pilotului, consimțământul, cohorta

Fișiere: `town-api/src/membership/civic-access.ts` (mecanism `accessUntil`,
deja existent, generic), schemă nouă pentru marcaj de cohortă.

**PASS:** acces de 90 de zile acordat prin `accessUntil`, **fără a trece prin
Stripe** (Stripe are URL-uri fixe de succes/eșec, nepotrivite pt. subdomeniu
— vezi dovezi); acordarea e auditată (cine, cui, când); cohorta Madrid e
marcată separat de membership-ul general.
**FAIL:** orice acces acordat fără urmă de audit, sau orice amestec cu
membership-ul general TOWN.

### M5 — Analytics, funnel, export agregat

**PASS:** evenimentele traseului civic existent (confirmare, propunere,
deliberare, vot, mandat, acțiune, dovadă, verificare, rezultat) sunt
exportabile agregat pentru cohorta Madrid; fără tracking publicitar extern;
consimțământ separat pentru analiza agregată, capturat explicit.
**FAIL:** orice export care identifică o persoană individual fără
consimțământ explicit.

### M6 — Invitații și distribuire WhatsApp

**PASS:** link direct funcțional per semnal; mesajul de invitație aprobat de
tine explicit înainte de trimitere; fără date/participanți simulați.
**FAIL:** orice trimitere fără aprobarea ta explicită a textului.

### M7 — Pagina publică de rezultat

Fișiere: `town-api/src/routes/civic-verification.ts` (stadiul `archived`,
deja existent, cu propunere câștigătoare, jurnal de dovezi, tally public).

**PASS:** pagina publică afișează rezultatul arhivat fără autentificare,
cu dovezi vizibile; niciun rezultat inventat pentru un proces nedecis.
**FAIL:** orice rezultat afișat pentru un proces neajuns la prag de decizie.

### M8 — E2E, securitate, capacitate, QA vizual

**PASS:** suite E2E verde; test dedicat CORS/CSRF/WebAuthn pe noul origin
verde; test de capacitate comparabil cu cel din `loadtest/README.md`; QA
vizual mobil + desktop aprobat personal de tine (nu de agent).
**FAIL:** orice test roșu sau QA vizual neaprobat de tine.

### M9 — Lansare Production controlată

**Autorizare separată, obligatorie.** Nu se autorizează decât după ce gate-ul
de stabilizare de mai sus e complet PASS, confirmat de tine personal.

### M10 — Test cu 10 persoane

Production, dar **fără dezvoltări simultane**. Raport de maximum o pagină
(vezi șablonul din strategia originală, punctul 11) obligatoriu înainte de
M11. Dacă apare un blocaj, recrutarea se oprește și se repetă testul cu
aceeași cohortă.

### M11 — Extindere 25 → 50 → 150

Fiecare prag (25, 50, 150) autorizat separat de tine, numai după raport
PASS la pragul anterior.

## Interdicții permanente (din strategia originală, punctul 12)

Nu se autorizează întregul plan dintr-un mesaj. „CI verde” nu e dovadă
suficientă fără verificare directă (exact greșeala corectată azi la gate-ul
de restore). Fără schimbări directe în Production. Fără funcții noi în timpul
testului cu utilizatori. Fără schimbarea semnalului principal după începerea
măsurătorilor. Fără promovare înaintea testului cu 10 persoane. Conturile
create nu sunt membri activi până confirmate. Fără corectare retroactivă a
datelor pilotului. Fără transformarea unei probleme nerezolvate în succes
artificial.

## Oprire automată

Agentul se oprește și raportează dacă: găsește o stare diferită de acest
plan; are nevoie de o decizie nouă; testele sunt roșii; nu poate verifica
mediul; ar trebui să atingă alt repository, baza de date sau Production fără
menționare explicită; criteriul de acceptare e ambiguu; descoperă modificări
paralele; soluția ar necesita eliminarea unei funcții existente.

## Formularul exact de autorizare

```
Autorizez exclusiv etapa Madrid Mx, conform PILOT_MADRID_MASTER_PLAN.md,
numai în repository-ul și fișierele enumerate în etapa respectivă. Nu
autorizez extinderea scopului, modificări în Production, seed, migrări,
merge sau deploy, decât dacă sunt menționate explicit. Livrabil obligatoriu:
diff, teste, CI, riscuri și dovezi. STOP la prima abatere, presupunere
neverificată sau test eșuat.
```

Merge și deploy se autorizează separat, după verificarea dovezilor.
