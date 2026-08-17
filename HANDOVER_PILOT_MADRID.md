# Raport de predare — pilotul `madrid.towncivic.org`

**Data:** 2026-08-17. **Scop:** un agent independent (Cursor) trebuie să poată
verifica singur fiecare afirmație. Platforma generală e tratată **separat**, în
`HANDOVER_PLATFORMA_TOWNCIVIC.md`.

Marcajele de încredere sunt aceleași: **[VERIFICAT]** (comandă rulată sau
înregistrare externă), **[DECLARAT]** (scrie în documentație, nereconfirmat),
**[NEVERIFICAT]** (lacună recunoscută).

Mediul în care a fost scris raportul **nu poate deschide
`madrid.towncivic.org`** — proxy-ul blochează domeniul. Deci **niciun ecran
n-a fost văzut de autor.** Ce urmează despre experiența utilizatorului vine
din trasare de cod și din loguri HTTP reale, nu din vizionare.

---

## 1. Ce este pilotul, mecanic

Pilotul **nu e o aplicație separată.** E același site, servit de același
serviciu, din aceleași fișiere ca `towncivic.org`. Singura diferență se produce
în browser, la runtime.

```
                    serviciul Railway `town-public` (production)
                    aceleași fișiere pentru toate domeniile
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  towncivic.org              madrid.towncivic.org         www.towncivic.org
        │                           │                     (redirect → apex)
        │                           │
        │                    madrid-pilot-host.js
        │                    recunoaște hostname-ul
        │                           │
        │                    resolvePilotCityId() → "Madrid"
        │                           │
        ▼                           ▼
  toate cele 22 orașe        PRODUCT_ONLY_CITY_ORDER = ["Madrid"]
  (67 semnale)                     3 semnale
```

**Punctul de eșec pe care trebuie să-l știi:** dacă `script.js` nu se încarcă
în versiunea nouă, lock-ul dispare și pilotul arată toate orașele. Exact asta
s-a întâmplat pe 17 august — vezi secțiunea 6.

Fișierele care fac pilotul [VERIFICAT]:

| Fișier                             | Rol                                                                   |
| ---------------------------------- | --------------------------------------------------------------------- |
| `town-public/madrid-pilot-host.js` | hostname → oraș; recunoaște `madrid.` și `madrid-staging.`            |
| `town-public/script.js:4259-4265`  | aplică lock-ul pe lista de orașe a feed-ului                          |
| `town-public/api-base.js:45-50`    | `madrid.towncivic.org` e host de producție → API-ul de producție      |
| `town-api/.../policy.ts:26-29`     | `https://madrid.towncivic.org` permis explicit ca origin de producție |

---

## 2. Ce vede efectiv un om care intră pe `madrid.towncivic.org`

Aceasta e secțiunea cea mai importantă, fiindcă nu a existat până acum.

```
deschide madrid.towncivic.org
   │
   ▼
aterizează direct pe feed          [VERIFICAT — script.js:8638]
   │                                fără hash în URL, modul product-only
   │                                rutează automat la `feed`
   ▼
vede 3 semnale, toate din Madrid   [VERIFICAT — confirmare vizuală Mihail,
   │                                17 aug + trafic HTTP real]
   │
   ├─ 1. Calle Argumosa       (trotuar)
   ├─ 2. Legazpi / parque Tierno Galván (felinare stinse)
   └─ 3. Puerta de Alcalá / Retiro
   │
   │   fiecare semnal are: categorie, titlu, rezumat, descriere,
   │   „de ce contează", „pe cine afectează", stare civică,
   │   dată de observare, autor („Redacción TOWN Madrid")
   │   ȘI un link Google Maps în descriere
   │
   ├─► poate deschide detaliul unui semnal
   ├─► poate primi link direct: madrid.towncivic.org/#/feed/madrid-signal-2
   │
   └─► panoul Profil ─► buton membership ─► cont: email → cod →
                        parolă/passkey → commitment → activ
```

### 2.1 Jurnal de utilizator real — observațiile lui Mihail, 17 august

**Aceasta e cea mai bună dovadă din tot documentul**, fiindcă e singura care
vine dintr-un browser real, nu din cod. Mihail a parcurs fluxul de patru ori
și a raportat de fiecare dată ce vedea pe ecran. **Observațiile lui au fost
dovada care a condus întreaga diagnoză** — agentul greșise de două ori
înainte, presupunând că merge.

| #   | Ce a raportat, în cuvintele lui                                                                                                                                                                                                                                                         | Ce s-a dovedit că era                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | „nu vad semnale, văd doar TOWN — No live signals right now. Couldn't reach TOWN — try again later."                                                                                                                                                                                     | CORS bloca originul `madrid.towncivic.org`; API-ul refuza cererea                      |
| 2   | „pe `madrid.towncivic.org/#/feed` vad 67 de semnale" — cu lista completă lipită, din Milano, München, Köln, Arad, Cluj, Budapesta, Madrid, Barcelona etc.                                                                                                                               | `script.js` vechi din cache; lock-ul Madrid nu se executa                              |
| 3   | „pe `madrid-staging.towncivic.org/#/feed` apar cele trei semnale dar pe `madrid.towncivic.org/#/feed` nu apar"                                                                                                                                                                          | **comparația care a izolat problema la cache**, nu la cod — staging n-avea cache vechi |
| 4   | „3 semnale Madrid" + textul randat: „Madrid / ALUMBRADO PÚBLICO / Varias farolas llevan semanas apagadas junto al parque Tierno Galván / **Legazpi** / El tramo entre la estación y las viviendas queda a oscuras después del anochecer. / Redacción TOWN Madrid · 9 de agosto de 2026" | starea corectă, după bumpul cheii de cache și re-rularea seed-ului                     |

Observația 2 conținea și dovada celei de-a doua probleme, independente:
semnalul purta încă eticheta veche „Vallecas". De acolo a pornit descoperirea
că baza de date de producție fusese populată înainte de corectura de conținut.

**Ce arată asta despre metodă:** de fiecare dată când agentul a spus „merge"
pe baza unui status de CI sau de deploy, verificarea vizuală a lui Mihail a
contrazis-o. Singurele afirmații „funcționează" care au rezistat sunt cele
confirmate din ecranul lui.

### Ce **nu** poate face, și e important

**Nu poate participa fără cont.** Confirmarea unui semnal, propunerea,
deliberarea și votul cer autentificare [VERIFICAT — 99 din 120 de rute API au
marcaj de autentificare; toate rutele `POST` din procesul civic sunt printre
ele].

**Nu există niciun proces civic pornit pe cele 3 semnale Madrid.**
[VERIFICAT — `src/db/seeds/foundation-content.ts`, semnalele Madrid au
`statusLabel: 'Estado cívico: observado — a la espera de atención local'` și
`latestUpdate: 'Todavía no se ha confirmado ninguna intervención'`. Seed-ul
creează **numai** comunități și semnale — nu creează rânduri de proces civic.]

Practic: procesul civic în 7 etape, care e teza produsului, **pornește doar
dacă utilizatori reali confirmă semnalele până la prag.** Cu 10 persoane
invitate, e o întrebare deschisă dacă pragul se atinge. Asta e riscul central
al pilotului, și e un risc de produs, nu un bug.

---

## 3. Constatare nouă, nedocumentată până acum: semnalele Madrid nu au poze

[VERIFICAT — două comenzi]

```bash
# ce imagini cere seed-ul pentru Madrid
grep -o "assets/feed/madrid[a-z0-9_]*\.jpg" town-api/src/db/seeds/foundation-content.ts | sort -u
#   assets/feed/madrid_signal_1.jpg
#   assets/feed/madrid_signal_2.jpg
#   assets/feed/madrid_signal_3.jpg

# ce imagini exista efectiv
ls town-public/assets/feed/
#   README_FICTIONAL_PROTOTYPE.txt
#   signal_citta_studi_pavement.jpg
#   signal_lorenteggio_works.jpg
#   signal_porta_romana_lighting.jpg
```

**Niciuna dintre cele trei imagini Madrid nu există.** Doar cele trei imagini
din Milano există.

Ce se întâmplă în interfață [VERIFICAT — `script.js:8813-8821`]:

```js
function resolveSceneImage(imageKey, cityId) {
  if (imageKey && KNOWN_FEED_IMAGES[imageKey]) return imageKey;   // 1. nu se potriveste
  if (CITY_PLACEHOLDER_IMAGES[cityId]) return CITY_PLACEHOLDER_IMAGES[cityId]; // 2. AICI cade
  ...
}
```

`KNOWN_FEED_IMAGES` conține exact 3 chei, toate din Milano
(`script.js:2145-2149`). Cheile Madrid nu sunt acolo, deci codul cade pe
placeholder-ul orașului: **`assets/cities/madrid.svg`, o siluetă gri de
skyline, nu o fotografie a problemei.**

Asta se confirmă în traficul real: în logurile HTTP ale serviciului de
producție, browserul cere `assets/cities/madrid.svg`, niciodată
`madrid_signal_*.jpg`.

**Deci:** cele 3 semnale Madrid sunt ilustrate acum cu aceeași siluetă generică
de oraș, de trei ori. Nu e o eroare vizibilă (nu apare imagine ruptă) — dar
înseamnă că un vizitator nu vede problema despre care citește.

**Corecție la o afirmație anterioară a autorului:** pe 17 august, autorul i-a
spus lui Mihail că cererea de `madrid.svg` în loguri „dovedește că feed-ul e
blocat pe Madrid". Concluzia rămâne validă (niciun alt oraș nu apare), dar
autorul nu știa atunci **de ce** apare acel fișier. Motivul real e lipsa
pozelor, descoperită abia acum.

---

## 4. Stare pe fiecare etapă (slice)

| Etapă                               | Ce trebuia                     | Stare reală                           | Ce lipsește                                                  |
| ----------------------------------- | ------------------------------ | ------------------------------------- | ------------------------------------------------------------ |
| **M0** inventar                     | raport read-only               | **[DECLARAT] gata**                   | —                                                            |
| **M1** plan, criterii               | 4 documente cu criterii binare | **[VERIFICAT] gata**                  | —                                                            |
| **M2** Madrid pe hostname (staging) | feed blocat pe Madrid          | **[DECLARAT] gata**                   | CORS live nu a fost testat prin HTTP real                    |
| **M3** conținut, proveniență        | sursă per semnal               | **[VERIFICAT] parțial**               | **poze reale — vezi §3**; acum doar link Google Maps în text |
| **M4** acces pilot, cohortă         | tabelă + acces 90 zile         | **[VERIFICAT] cod și schemă gata**    | **niciun acces acordat cuiva**                               |
| **M5** analytics, export            | export agregat                 | **[VERIFICAT] parțial**               | **consimțământ — zero implementare**                         |
| **M6** invitații                    | mesaj + linkuri                | **[VERIFICAT] gata**                  | mesajul **nu a fost trimis**                                 |
| **M7** pagină de rezultat           | rezultat public fără login     | **[VERIFICAT] gata, cod preexistent** | —                                                            |
| **M8** E2E, QA, capacitate          | suite verzi                    | **[DECLARAT] aproape**                | E2E Playwright în browser real                               |
| **M9** lansare producție            | domeniu funcțional             | **[VERIFICAT] gata**                  | —                                                            |
| **M10** test cu 10 persoane         | —                              | **neînceput**                         | tot                                                          |
| **M11** extindere 25→50→150         | —                              | **neînceput**                         | tot                                                          |

**Tabela `pilot_cohort_members` există în producție** [VERIFICAT — migrația
`drizzle/0059_pilot_cohort_members.sql` a fost aplicată pe baza de date de
producție pe 17 aug, în incidentul de la 08:32]. Constrângerea permite un
singur tip de cohortă: `'madrid_pilot'`.

**Dar niciun rând nu a fost creat.** [DECLARAT — `PILOT_MADRID_STATUS.md`:
„cod gata, nimic rulat pe bază de date"]. Deci **nimeni nu are acces de 90 de
zile în acest moment.** Cum se acordă efectiv accesul primilor 10 oameni este
un pas care **nu a fost executat și nu a fost testat niciodată end-to-end.**

---

## 5. Blocante reale înainte de a invita 10 oameni

În ordinea în care ar strica testul.

1. **Nu s-a acordat niciodată un acces de pilot, nici măcar de probă.**
   Codul și tabela există; parcursul complet „om invitat → cont → membru al
   cohortei → 90 de zile" nu a fost parcurs niciodată de nimeni. Aceasta e cea
   mai mare necunoscută. **[NEVERIFICAT]**
2. **Consimțământ inexistent.** Zero apariții în cod. Prin propriul criteriu
   M5 al lui Mihail, exportul de funnel nu poate fi folosit public fără el.
   Nu blochează rularea testului, blochează folosirea rezultatelor.
3. **Semnalele nu au poze** (§3). Un pilot civic în care nu vezi problema
   pierde exact impactul care produce participare.
4. **Emailurile nu sunt în spaniolă.** Utilizatori din Madrid primesc codul de
   verificare în altă limbă. Atinge fiecare persoană care își face cont.
5. **Procesul civic nu pornește singur** (§2). Dacă cei 10 nu ating pragul de
   confirmare, etapele 1–7 nu sunt testate deloc.
6. **`town-public` producție se poate redesfășura la push în `main`** —
   configurația nu are filtru, deși empiric nu s-a observat declanșare. Neclar,
   vezi raportul de platformă §5.1. Cât ține testul, orice push în `town-public`
   e un risc netestat pentru site-ul pe care îl folosesc testerii.

---

## 6. Ce a mers prost pe 17 august, ca lecție operațională

Pilotul a fost declarat funcțional de două ori înainte să fie funcțional.

**Prima dată:** backend și frontend desfășurate, CI verde, Railway `SUCCESS` —
și `madrid.towncivic.org` afișa 67 de semnale din toate orașele. Două cauze
independente [VERIFICAT — loguri HTTP + git]:

- lock-ul Madrid intrase în `script.js` **fără să i se schimbe cheia de cache
  `?v=`**, deci browserele care mai vizitaseră domeniul reluau versiunea veche
  din cache. `index.html` se reîmprospăta, deci se descărca fișierul nou
  `madrid-pilot-host.js`, dar `script.js` — cel care îl folosește — nu.
- baza de date de producție fusese populată **cu 74 de minute înainte** de
  corectura de conținut, deci un semnal afișa o etichetă greșită.

**Lecția, formulată exact:** „deploy SUCCESS" înseamnă că serverul are
fișierele noi. **Nu** înseamnă că browserul utilizatorului le execută. Între
cele două stă cache-ul, iar cache-ul nu apare în niciun status de CI.

Verificarea care a găsit răspunsul în câteva minute, după ore de presupuneri —
și care ar trebui folosită prima data viitoare:

```
Railway → serviciul town-public → Observability → HTTP logs
Se urmărește ce fișiere cere efectiv browserul.
Absența unui GET /script.js după un deploy = browserul foloseste cache vechi.
```

---

## 7. Sarcini pentru agentul independent

1. **Extinde jurnalul de utilizator real din §2.1**, care există deja —
   Mihail a parcurs fluxul de patru ori pe 17 august și a raportat ce vedea.
   Ce **nu** e acoperit acolo și lipsește: parcursul de creare de cont
   (Profil → membership → email → cod → parolă/passkey), pe care nimeni nu
   l-a parcurs pe domeniul de producție. Fă-l într-o fereastră privată și
   notează fiecare pas.
2. **Verifică §3** — confirmă că cele 3 semnale afișează silueta generică și nu
   o fotografie. Decide dacă e acceptabil pentru un pilot cu oameni reali.
3. **Testează acordarea accesului de pilot** pe staging, cap-coadă, cu un cont
   de test: invitație → cont → intrare în `pilot_cohort_members` → 90 de zile
   active. Acesta e blocantul #1 și n-a fost făcut niciodată.
4. **Verifică lock-ul cu cache gol și cu cache vechi:**
   ```bash
   curl -s https://madrid.towncivic.org/ | grep -o 'script.js?v=[a-z0-9-]*'
   # asteptat: script.js?v=madrid-pilot-1
   curl -s https://madrid.towncivic.org/build-identity.json
   # asteptat: commit-ul curent din main, environment: production
   ```
5. **Confirmă izolarea:** `towncivic.org` trebuie să arate toate orașele,
   `madrid.towncivic.org` doar Madrid, din același serviciu.
6. **Verifică limba emailurilor** trimise unui cont nou creat din Madrid.
7. **Decide ce înseamnă succes la 10 persoane**, înainte de a invita pe cineva.
   Fără o definiție scrisă dinainte, rezultatul va fi interpretat retroactiv —
   ceea ce regulile proiectului interzic explicit.

---

## 8. Notă despre autorul acestui document

Scris de agentul AI care a lucrat pe 16–17 august. În acea perioadă a produs
trei incidente de producție și a declarat pilotul funcțional de două ori
înainte să fie. Toate sunt documentate, cu marcaje de timp, în
`PILOT_MADRID_EVIDENCE.md`.

**Precizare importantă, corectată:** deși lucrarea a fost pornită ca „pilot
Madrid", autorul **nu a modificat doar pilotul.** A schimbat schema bazei de
date partajate, politica de securitate a producției, contractul public de
API, monitorizarea întregii platforme, bundle-ul principal de frontend și
configurația de deploy a producției. Amprenta completă e la secțiunea 9 din
`HANDOVER_PLATFORMA_TOWNCIVIC.md`. O versiune anterioară a acestor rapoarte
descria autorul drept cineva care „a lucrat la pilotul Madrid", ceea ce era
fals prin omisiune.

Documentul acesta e o depoziție, nu un adevăr. Fiecare afirmație are marcaj de
încredere și, unde e posibil, comanda de verificare. Constatarea din §3
(semnalele fără poze) a fost descoperită în timpul scrierii acestui raport, nu
înainte — ceea ce arată că lista de mai sus **nu e completă.** Presupune că
mai există lucruri nedescoperite și caută-le.

Dacă găsești o contradicție între acest document și sistemul real, sistemul
real are dreptate.
