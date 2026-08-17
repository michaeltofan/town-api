# Raport de predare — platforma `towncivic.org`

**Data:** 2026-08-17. **Scop:** un agent independent (Cursor) trebuie să poată
verifica singur fiecare afirmație de aici, fără să aibă încredere în autorul
documentului. Pilotul Madrid e tratat **separat**, în
`HANDOVER_PILOT_MADRID.md`.

Documentul acesta descrie **platforma generală**: ce este, ce funcționează,
ce nu, unde sunt punctele slabe.

---

## 0. Cum se verifică acest document

Fiecare afirmație are, lângă ea, comanda care o confirmă sau o infirmă.
Regula: **dacă o comandă contrazice textul, comanda are dreptate.**

Trei niveluri de încredere, marcate peste tot:

| Marcaj            | Înseamnă                                                                      |
| ----------------- | ----------------------------------------------------------------------------- |
| **[VERIFICAT]**   | Confirmat prin comandă rulată sau înregistrare externă (Railway, GitHub, git) |
| **[DECLARAT]**    | Scrie undeva în documentație, dar nu a fost reconfirmat aici                  |
| **[NEVERIFICAT]** | Nimeni nu l-a verificat; tratează-l ca necunoscut                             |

Mediul în care a fost scris acest raport **nu are acces de rețea** la
`towncivic.org`, `api.towncivic.org` sau `madrid.towncivic.org` (blocat de
proxy). Deci **nicio afirmație despre comportamentul live prin HTTP direct nu
a fost testată de autor.** Verificările live sunt sarcini pentru agentul care
citește acest document, marcate ca atare la secțiunea 8.

---

## 1. Ce este platforma

TOWN e o platformă civică. Un cetățean vede „semnale" — probleme reale de
cartier — și le poate duce printr-un proces civic în 7 etape.

**Procesul civic, cele 7 etape** [VERIFICAT — `ls src/routes/civic-*.ts`]:

```
semnal observat
   │
   ├─► confirmare            PUT  /v1/signals/:id/confirmation
   │                         (praguri de confirmare deschid procesul)
   ▼
civic-process               GET  /v1/signals/:id/civic-process
   │
   ├─1─► propuneri           civic-proposals.ts
   ├─2─► deliberare          civic-deliberation.ts
   ├─3─► vot                 civic-voting.ts
   ├─4─► mandat              civic-mandate.ts
   ├─5─► acțiune             civic-action.ts
   ├─6─► verificare          civic-verification.ts
   └─7─► rezultat public     GET .../civic-process/verification  (fără login)
```

---

## 2. Topologia reală a infrastructurii

[VERIFICAT — Railway MCP `list-services`, `list-domains`, `get-service-config`]

Un singur proiect Railway: `town-public`, id `8fd67de0-2ed1-4906-bf5a-36207191c613`.
(Numele proiectului e înșelător — conține și backend-ul.)

**Medii:** `production` (`d6297195`), `staging` (`a7e3d77f`), plus `prod` și
`capacity`, nefolosite pentru trafic real.

| Serviciu                                     | Mediu      | Domenii                            | Ce rulează         |
| -------------------------------------------- | ---------- | ---------------------------------- | ------------------ |
| `town-api`                                   | production | `api.towncivic.org`                | API-ul Fastify     |
| `town-public`                                | production | `towncivic.org`, `www.`, `madrid.` | site static, Caddy |
| `town-api-staging`                           | staging    | `api-staging.towncivic.org`        | API staging        |
| `town-public-staging`                        | staging    | `madrid-staging.towncivic.org`     | site staging       |
| `town-api-migrations`                        | production | —                                  | migrări manuale    |
| `town-api-seed-production`                   | production | —                                  | seed manual        |
| `Postgres`, `Postgres-9UWs`, `Postgres-ykVK` | —          | —                                  | baze de date       |

**Atenție, punct de confuzie real:** `towncivic.org` și `madrid.towncivic.org`
sunt **același serviciu, aceleași fișiere**. Diferența dintre ele e făcută
exclusiv în JavaScript, la runtime, după `window.location.hostname`. Nu există
build separat pentru Madrid.

---

## 3. Suprafața API — ce e public și ce e protejat

[VERIFICAT — extragere din `src/routes/*.ts`; script reproductibil mai jos]

**120 de rute** înregistrate, în 32 de fișiere.

```bash
# reproduce numărătoarea și lista completă
cd town-api && python3 - <<'PY'
import re,glob
r=[]
for f in glob.glob('src/routes/*.ts'):
    for m in re.finditer(r"\bapp\.(get|post|patch|put|delete)\(\s*\n?\s*'([^']+)'", open(f).read()):
        r.append((m.group(1).upper(), m.group(2)))
print(len(r))
for x in sorted(set(r), key=lambda t:t[1]): print(*x)
PY
```

**21 de rute fără marcaj de autentificare.** Toate sunt justificat publice —
verificate una câte una:

- 3 de sănătate: `/health/live`, `/health/ready`, `/health/build`
- 11 de citire publică: catalogul de comunități, semnalele, toate etapele
  procesului civic la `GET` (transparență civică — e o decizie de produs, nu
  o scăpare), media semnalelor
- 6 puncte de intrare în autentificare: login cu parolă, passkey options/verify,
  recuperare cont, confirmare email
- 1 webhook: `POST /v1/billing/google-play/rtdn`

**Webhook-ul Google Play este autentificat** [VERIFICAT —
`src/routes/google-play-rtdn.ts:122` aruncă `401 PUBSUB_PUSH_NOT_AUTHORIZED`,
prin `verify-pubsub-push.js`; corpul rămâne opac până după autentificare,
linia 64]. **Nu e o vulnerabilitate.**

**99 de rute protejate**, inclusiv toate cele 40+ de rute `/v1/platform/*`
(consola de operator).

---

## 4. Postura de securitate

| Element                        | Stare                                                                                                                                                     | Cum verifici                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| CORS                           | **[VERIFICAT]** `Set.has(origin)` pe lista exactă din `WEBAUTHN_ALLOWED_ORIGINS`, fără wildcard                                                           | `src/plugins/cors.ts`, `src/ops/cors-origins.ts`            |
| Origini de producție           | **[VERIFICAT]** listă enumerată explicit, 2 intrări, nu pattern                                                                                           | `src/ceremony/passkey-registration/policy.ts:26-29`         |
| Politică la boot               | **[VERIFICAT]** producția refuză să pornească dacă originile nu sunt exact din listă                                                                      | `config.ts:189-203`, apelat din `config/env.ts` în 3 puncte |
| CSP / HSTS / anti-clickjacking | **[VERIFICAT]** `script-src 'self'`, `frame-ancestors 'none'`, HSTS 1 an                                                                                  | `town-public/Caddyfile`                                     |
| Autentificare                  | **[DECLARAT]** parolă + passkey (WebAuthn), ambele funcționale                                                                                            | testat în CI, nu live de autor                              |
| Izolare secrete                | **[VERIFICAT]** autorul **nu** a citit niciodată valorile variabilelor de producție; a folosit doar `get-service-config`, care returnează nume, nu valori | —                                                           |

**O singură variabilă (`WEBAUTHN_ALLOWED_ORIGINS`) controlează trei lucruri
simultan: CORS, CSRF și originile WebAuthn.** [VERIFICAT — trasare completă a
consumatorilor]. Asta a produs deja o cădere de producție pe 17 aug. E un
punct de fragilitate arhitecturală: o editare greșită acolo oprește aplicația
la pornire. Comportamentul e intenționat (fail-closed), dar concentrarea de
responsabilități merită documentată pentru oricine atinge acea variabilă.

---

## 5. Puncte slabe reale, în ordinea gravității

### 5.1 Servicii care se redesfășoară singure la orice push în `main`

Cel mai important risc operațional al platformei. [VERIFICAT — configurații
Railway + înregistrări de deployment cu `commitHash`]

| Serviciu                   | Filtru `watchPatterns`                  | Auto-deploy dovedit                   | Migrări la deploy | Stare              |
| -------------------------- | --------------------------------------- | ------------------------------------- | ----------------- | ------------------ |
| `town-api` producție       | **DA** (`/.railway/manual-api-only/**`) | da, `a967c06d` 17 aug 08:32           | **DA**            | **reparat 17 aug** |
| `town-api-staging`         | **NU**                                  | da, `80d2952c` (`commitHash 0ad0db4`) | **DA**            | **DESCHIS**        |
| `town-public` producție    | **NU**                                  | nedovedit — vezi mai jos              | nu                | **NECLAR**         |
| `town-public-staging`      | **NU**                                  | [NEVERIFICAT]                         | nu                | **NECLAR**         |
| `town-api-migrations`      | DA (santinelă)                          | —                                     | —                 | protejat           |
| `town-api-seed-production` | DA (santinelă)                          | —                                     | —                 | protejat           |

**Ce s-a reparat:** doar `town-api` producție, fiindcă doar atât a fost
autorizat. Restul rămân neatinse, deliberat.

**Discrepanță pe care autorul NU o poate explica și nu o ghicește:**
`town-public` producție nu are filtru în configurație, dar merge-ul în `main`
de azi, ora 11:02, **nu** a produs niciun deployment nativ — singurul din acea
fereastră e `371845e6`, la 11:04, care e deploy-ul prin CI. Deci ceva îl
oprește, dar nu s-a stabilit ce. **Sarcină pentru agentul independent**, nu
concluzie.

**De ce contează:** regula „nu se schimbă nimic în timpul testului cu
utilizatori" e imposibil de respectat cât timp scrierea în documentele de
guvernanță redesfășoară infrastructura. Pe `town-api` producție e rezolvat.
Pe staging, nu.

### 5.2 Documentație falsă care a ținut riscul ascuns

[VERIFICAT] Commit-ul `28f46bd` afirmă că _fiecare_ serviciu Railway din
proiect e protejat de un filtru `watchPatterns` și deci „merging to main does
not deploy by itself". **E fals pentru cel puțin trei servicii.** Această
propoziție e motivul pentru care riscul de la 5.1 a rămas invizibil luni de
zile. Documentația greșită a fost mai periculoasă decât configurația greșită.

### 5.3 Erori 500 neexplicate, în producție

[DECLARAT, cu dovadă parțială] Consola `ops_admin` a arătat 500-uri reale,
recurente, pe `GET /v1/signals/:signalId/civic-process` și
`GET /v1/account/activity`, între 6 și 8 august. Cauza probabilă a fost
localizată în cod (`civic-process.ts:200-202`, un guard de backfill după
re-seed), dar **nu a fost confirmată** — logurile Railway din acea perioadă au
expirat, iar consola nu stochează niciodată mesajul real al erorii (decizie
de securitate). Zero recurențe în 9+ zile.

Mihail a decis explicit să continue cu această stare. Decizia e a lui,
înregistrată. Dar nu e un PASS curat și nu trebuie prezentată ca atare.

### 5.4 Migrările rulează automat înainte de fiecare deploy

[VERIFICAT] Ambele servicii API au `preDeployCommand: ["npm run
db:migrate:production"]`. Nu există niciun pas manual de aprobare între
„pornește deploy-ul" și „modifică schema bazei de date de producție". Combinat
cu 5.1, asta a produs incidentul din 17 august.

### 5.5 Gol de snapshot-uri Drizzle

[DECLARAT] Snapshot-urile 0014–0058 lipsesc din `drizzle/meta/`. Consecința
practică: `drizzle-kit` nu poate genera corect diff-uri pe acel interval.
A produs deja un bug real (migrația 0059, cu timestamp mai mic decât 0058,
ignorată tăcut pe baze de date populate — reparat).

### 5.6 Emailuri într-o singură limbă

[DECLARAT] Mecanismul de email funcționează, dar nu există variantă în
spaniolă. Pentru utilizatori din Madrid, orice email de verificare sau
recuperare ajunge în altă limbă decât interfața.

### 5.7 Documentele de guvernanță au rămas în urmă la final

[VERIFICAT] `PILOT_MADRID_STATUS.md` are în antet „Actualizat: 2026-08-16",
deși conține secțiuni din 17 august. Regula „se actualizează după fiecare
acțiune reală" a cedat exact la acțiunile cu risc maxim.

---

## 6. Ce funcționează, confirmat

| Element                            | Dovadă                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| API-ul de producție răspunde       | **[VERIFICAT]** `health-alert.yml` run [#184](https://github.com/michaeltofan/town-api/actions/runs/32036174313), `success`, 13:39:59Z     |
| Monitorizare automată              | **[VERIFICAT]** poll la 15 minute pe `/health/live` + `/health/ready`, ambele medii, deschide issue automat la cădere                      |
| Deploy prin CI, cu poartă manuală  | **[VERIFICAT]** `ci.yml` — `deploy-production` cere `workflow_dispatch` **și** flag `deploy_production == 'true'` **și** `refs/heads/main` |
| Capacitate                         | **[DECLARAT]** 10.591 cereri, 0% eșecuri (`loadtest/README.md`) — nereconfirmat aici                                                       |
| Restore din backup                 | **[DECLARAT]** drill reușit 13 aug (după 7 eșecuri), atestat de Mihail personal în consolă                                                 |
| Export agregat fără date personale | **[VERIFICAT]** `GET /v1/platform/pilot/funnel-export` — doar numere; testat explicit că nu apar identificatori de cont                    |
| Webhook de plată autentificat      | **[VERIFICAT]** vezi secțiunea 3                                                                                                           |

---

## 7. Experiența utilizatorului pe `towncivic.org` (site-ul general)

[VERIFICAT prin trasare de cod — **nu** prin deschiderea site-ului]

Site-ul rulează în `PRODUCT_ONLY_PUBLIC_MODE = true` (`script.js:4254`). Asta
schimbă radical ce vede un vizitator față de ce există în cod.

**Există 16 ecrane** în `index.html`. În modul product-only, **un vizitator
anonim ajunge doar la unul: `feed`.**

```
vizitator anonim
   │
   ▼
#/feed ─── singurul ecran accesibil
   │       (orice alt hash e rescris către feed, script.js:8638-8654)
   │
   ├─► derulează semnale, citește detalii
   ├─► link direct către un semnal: #/feed/<slug>
   │
   └─► panoul Profil ──► buton membership ──► deblochează parcursul:
                          commitment → account → email → code →
                          password/passkey → ready → payment → active
                          (script.js:15006-15010)
```

Celelalte 15 ecrane **există în cod dar sunt inaccesibile** până când un
utilizator pornește deliberat parcursul de membership. Nu sunt cod mort — sunt
cod blocat de o poartă.

**Consecință de înțeles clar:** un vizitator care doar deschide `towncivic.org`
poate **citi**, nu poate **participa**. Participarea (confirmare, propunere,
vot) cere cont, iar contul cere ca utilizatorul să găsească butonul din panoul
de Profil.

---

## 8. Sarcini pentru agentul independent

Ordonate după valoare. Primele trei sunt lucruri pe care autorul **nu le-a
putut** face, nu lucruri pe care le-a sărit.

1. **Testează live ce autorul n-a putut testa.** Din rețea normală:
   ```bash
   curl -i https://api.towncivic.org/health/ready
   curl -i https://api.towncivic.org/v1/communities
   curl -i -H "Origin: https://madrid.towncivic.org" https://api.towncivic.org/health/ready
   # asteptat: access-control-allow-origin: https://madrid.towncivic.org
   curl -i -H "Origin: https://evil.example.com" https://api.towncivic.org/health/ready
   # asteptat: NU trebuie sa apara access-control-allow-origin pentru acest origin
   ```
2. **Rezolvă discrepanța de la 5.1** — de ce `town-public` producție nu se
   auto-desfășoară deși nu are filtru. Verifică în dashboard-ul Railway dacă
   integrarea GitHub e dezactivată la nivel de serviciu.
3. **Decide ce se face cu `town-api-staging`** — se auto-desfășoară dovedit și
   rulează migrări pe baza de date de staging la fiecare push în `main`.
4. **Verifică independent numerele declarate:** capacitate, număr de teste,
   atestarea de restore.
5. **Corectează documentația falsă** din `28f46bd` — vezi 5.2.
6. **Verifică rutele publice** din secțiunea 3 una câte una, cu `curl`, ca
   niciuna să nu returneze date care ar trebui protejate.
7. **Caută ce autorul n-a căutat:** limitare de rată (rate limiting) pe
   rutele de autentificare. Autorul **nu a verificat** dacă există, deci nu
   afirmă nici că există, nici că lipsește. Tratează ca [NEVERIFICAT].

---

## 9. Notă despre autorul acestui document

Documentul e scris de agentul AI care a lucrat la pilotul Madrid pe 16–17
august. Acel agent a produs trei incidente de producție în acea perioadă
(deploy neautorizat cu migrări, cădere la pornire, anularea unui deploy),
documentate în `PILOT_MADRID_EVIDENCE.md`.

**Tratează acest document ca pe o depoziție, nu ca pe un adevăr.** De asta
fiecare afirmație are marcaj de încredere și comandă de verificare. Cele
marcate **[VERIFICAT]** au fost confirmate prin comenzi rulate în timpul
scrierii. Cele marcate **[DECLARAT]** vin din documentația proiectului și
n-au fost reconfirmate. Cele **[NEVERIFICAT]** sunt lacune recunoscute.

Dacă găsești o contradicție între acest document și sistemul real, sistemul
real are dreptate.
