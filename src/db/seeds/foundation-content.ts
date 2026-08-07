/**
 * Canonical civic foundation content for TOWN Communities and Signals Foundation V1.
 *
 * Source of truth: michaeltofan/town-public (main) FEED_SCENES for Milano, Munich, and Arad.
 * Author display names are prototype editorial metadata, not verified user accounts.
 * Image keys are relative prototype asset keys only (no binary/CDN/absolute URLs).
 *
 * All identifiers and timestamps are fixed. Seed execution must not use Date.now()
 * or random UUID generation.
 */

export type CanonicalCommunity = {
  id: string;
  slug: string;
  position: number;
  countryCode: string;
  cityName: string;
  displayName: string;
  defaultLocale: string;
  timezone: string;
  status: 'active';
  createdAt: string;
  updatedAt: string;
};

export type CanonicalSignal = {
  id: string;
  communityId: string;
  slug: string;
  position: number;
  locale: string;
  category: string;
  area: string;
  headline: string;
  summary: string;
  description: string;
  whyItMatters: string;
  whoIsAffected: string;
  latestUpdate: string;
  statusLabel: string;
  statusNote: string;
  observedLabel: string;
  observedOn: string | null;
  observedPrecision: 'day' | 'week';
  authorDisplayName: string;
  imageKey: string;
  imageFocusX: number;
  imageFocusY: number;
  publicationStatus: 'published';
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
};

export const FOUNDATION_COMMUNITIES = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'milano-it',
    position: 1,
    countryCode: 'IT',
    cityName: 'Milano',
    displayName: 'Milano',
    defaultLocale: 'it-IT',
    timezone: 'Europe/Rome',
    status: 'active',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    slug: 'munich-de',
    position: 2,
    countryCode: 'DE',
    cityName: 'Munich',
    displayName: 'München',
    defaultLocale: 'de-DE',
    timezone: 'Europe/Berlin',
    status: 'active',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    slug: 'arad-ro',
    position: 3,
    countryCode: 'RO',
    cityName: 'Arad',
    displayName: 'Arad',
    defaultLocale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    status: 'active',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    slug: 'cluj-napoca-ro',
    position: 4,
    countryCode: 'RO',
    cityName: 'Cluj-Napoca',
    displayName: 'Cluj-Napoca',
    defaultLocale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    status: 'active',
    createdAt: '2026-08-07T08:00:00.000Z',
    updatedAt: '2026-08-07T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    slug: 'sibiu-ro',
    position: 5,
    countryCode: 'RO',
    cityName: 'Sibiu',
    displayName: 'Sibiu',
    defaultLocale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    status: 'active',
    createdAt: '2026-08-07T08:00:00.000Z',
    updatedAt: '2026-08-07T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    slug: 'iasi-ro',
    position: 6,
    countryCode: 'RO',
    cityName: 'Iași',
    displayName: 'Iași',
    defaultLocale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    status: 'active',
    createdAt: '2026-08-07T08:00:00.000Z',
    updatedAt: '2026-08-07T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000007',
    slug: 'timisoara-ro',
    position: 7,
    countryCode: 'RO',
    cityName: 'Timișoara',
    displayName: 'Timișoara',
    defaultLocale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    status: 'active',
    createdAt: '2026-08-07T08:00:00.000Z',
    updatedAt: '2026-08-07T08:00:00.000Z',
  },
] as const satisfies readonly CanonicalCommunity[];

export const FOUNDATION_SIGNALS = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    communityId: '00000000-0000-4000-8000-000000000001',
    slug: 'milano-signal-1',
    position: 1,
    locale: 'it-IT',
    category: 'SPAZIO PUBBLICO',
    area: 'Città Studi',
    headline: 'Marciapiede danneggiato davanti alla scuola di via Padova',
    summary:
      'Le radici hanno sollevato il marciapiede. Bambini e anziani sono costretti sulla carreggiata.',
    description:
      'Davanti alla scuola di via Padova il marciapiede è sollevato e spezzato. Il passaggio pedonale resta irregolare per diversi metri e costringe chi cammina a avvicinarsi alla carreggiata, soprattutto nelle ore di entrata e uscita.',
    whyItMatters:
      'Qui passa ogni giorno chi accompagna i bambini a scuola e chi si muove a piedi nel quartiere. Un marciapiede danneggiato non è un dettaglio estetico: riduce la sicurezza di un tratto quotidiano e molto frequentato.',
    whoIsAffected:
      'Famiglie con bambini, anziani, persone con mobilità ridotta e chi attraversa Città Studi a piedi nelle ore di punta.',
    latestUpdate:
      'Il segnale resta locale e aperto. Nessun intervento confermato risulta al momento.',
    statusLabel: 'Stato civico: osservato — in attesa di attenzione locale',
    statusNote:
      '«Osservato» significa che il problema è stato riconosciuto dalla comunità locale. Non implica una pratica ufficiale né un intervento già avviato.',
    observedLabel: 'Osservato ieri',
    observedOn: '2026-07-14',
    observedPrecision: 'day',
    authorDisplayName: 'Marta Rinaldi',
    imageKey: 'assets/feed/signal_citta_studi_pavement.jpg',
    imageFocusX: 50,
    imageFocusY: 42,
    publicationStatus: 'published',
    publishedAt: '2026-07-14T08:00:00.000Z',
    createdAt: '2026-07-14T08:00:00.000Z',
    updatedAt: '2026-07-14T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    communityId: '00000000-0000-4000-8000-000000000001',
    slug: 'milano-signal-2',
    position: 2,
    locale: 'it-IT',
    category: 'ILLUMINAZIONE',
    area: 'Porta Romana',
    headline: 'Il percorso vicino alla scuola resta al buio la sera',
    summary:
      'Diversi lampioni non funzionano sul tratto pedonale. I residenti hanno già segnalato il Comune.',
    description:
      'Sul tratto pedonale vicino alla scuola, più lampioni restano spenti dopo il tramonto. Il percorso tra le abitazioni e l’ingresso scolastico diventa difficile da leggere, soprattutto per chi torna a piedi la sera.',
    whyItMatters:
      'Una strada poco illuminata riduce il senso di sicurezza di un percorso scolastico e quotidiano. In un quartiere abitato, la luce pubblica è parte essenziale della vita locale.',
    whoIsAffected:
      'Studenti, genitori, residenti della sera e chi usa questo tratto pedonale per raggiungere fermate e abitazioni vicine.',
    latestUpdate:
      'Il segnale resta locale e aperto. Nessun intervento confermato risulta al momento.',
    statusLabel: 'Stato civico: segnalato — monitoraggio locale',
    statusNote:
      '«Segnalato» indica che il problema è stato portato all’attenzione locale. Non conferma riparazione, presa in carico formale o tempi di intervento.',
    observedLabel: 'Segnalato due giorni fa',
    observedOn: '2026-07-13',
    observedPrecision: 'day',
    authorDisplayName: 'Chiara Valli',
    imageKey: 'assets/feed/signal_porta_romana_lighting.jpg',
    imageFocusX: 58,
    imageFocusY: 40,
    publicationStatus: 'published',
    publishedAt: '2026-07-13T08:00:00.000Z',
    createdAt: '2026-07-13T08:00:00.000Z',
    updatedAt: '2026-07-13T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000103',
    communityId: '00000000-0000-4000-8000-000000000001',
    slug: 'milano-signal-3',
    position: 3,
    locale: 'it-IT',
    category: 'LAVORI PUBBLICI',
    area: 'Lorenteggio',
    headline: 'Il cantiere restringe il passaggio pedonale senza indicazioni chiare',
    summary:
      'Il percorso temporaneo è stretto e poco segnalato. Servono tempi chiari e un passaggio più sicuro.',
    description:
      'Il cantiere ha ristretto il passaggio pedonale a un corridoio stretto, con indicazioni poco leggibili. Pedoni e ciclisti si trovano a condividere uno spazio ridotto, senza un percorso alternativo chiaro.',
    whyItMatters:
      'I lavori pubblici fanno parte della vita di quartiere, ma senza indicazioni e tempi comprensibili il passaggio quotidiano diventa confuso e meno sicuro.',
    whoIsAffected:
      'Pedoni, ciclisti, residenti di Lorenteggio e chi attraversa l’area per lavoro o scuola.',
    latestUpdate:
      'Il segnale resta locale e aperto. Nessun intervento confermato risulta al momento.',
    statusLabel: 'Stato civico: aperto — richiede chiarezza locale',
    statusNote:
      '«Aperto» significa che la situazione resta da chiarire per la comunità. Non implica una decisione amministrativa già conclusa.',
    observedLabel: 'Osservato questa settimana',
    observedOn: null,
    observedPrecision: 'week',
    authorDisplayName: 'Luca Ferri',
    imageKey: 'assets/feed/signal_lorenteggio_works.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-07-12T08:00:00.000Z',
    createdAt: '2026-07-12T08:00:00.000Z',
    updatedAt: '2026-07-12T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000201',
    communityId: '00000000-0000-4000-8000-000000000002',
    slug: 'munich-signal-1',
    position: 1,
    locale: 'de-DE',
    category: 'ÖFFENTLICHER RAUM',
    area: 'Schwabing',
    headline: 'Der Gehweg ist hier kaum noch sicher passierbar.',
    summary:
      'Unebene Platten verengen den Gehweg. Menschen mit Kinderwagen oder Rollstuhl müssen auf die Straße ausweichen.',
    description:
      'In Schwabing ist der Gehweg durch angehobene und unebene Platten stark eingeschränkt. Der sichere Fußweg wird schmal, sodass Menschen näher an den Fahrbahnrand ausweichen müssen.',
    whyItMatters:
      'Ein beschädigter Gehweg betrifft den Alltag im Viertel. Er macht einen häufig genutzten Weg unsicherer — besonders für Familien, ältere Menschen und alle, die zu Fuß unterwegs sind.',
    whoIsAffected:
      'Familien mit Kinderwagen, ältere Menschen, Personen mit eingeschränkter Mobilität und Fußgängerinnen und Fußgänger im täglichen Weg durch Schwabing.',
    latestUpdate: 'Das Signal bleibt lokal und offen. Derzeit liegt keine bestätigte Maßnahme vor.',
    statusLabel: 'Bürgerlicher Status: beobachtet — wartet auf lokale Aufmerksamkeit',
    statusNote:
      '„Beobachtet“ bedeutet, dass die lokale Gemeinschaft das Problem erkannt hat. Es bedeutet keine offizielle Akte und keinen bereits begonnenen Eingriff.',
    observedLabel: 'Gestern beobachtet',
    observedOn: '2026-07-14',
    observedPrecision: 'day',
    authorDisplayName: 'Anna Weber',
    imageKey: 'assets/feed/signal_citta_studi_pavement.jpg',
    imageFocusX: 50,
    imageFocusY: 42,
    publicationStatus: 'published',
    publishedAt: '2026-07-14T08:00:00.000Z',
    createdAt: '2026-07-14T08:00:00.000Z',
    updatedAt: '2026-07-14T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000202',
    communityId: '00000000-0000-4000-8000-000000000002',
    slug: 'munich-signal-2',
    position: 2,
    locale: 'de-DE',
    category: 'STRASSENBELEUCHTUNG',
    area: 'Haidhausen',
    headline: 'Mehrere Straßenlaternen bleiben am Abend dunkel.',
    summary:
      'Der Fußweg zwischen Wohnhäusern und Haltestelle ist kaum beleuchtet. Anwohner haben die Störung bereits gemeldet.',
    description:
      'Mehrere Laternen am Fußweg zwischen Wohnhäusern und Haltestelle bleiben nach Einbruch der Dunkelheit aus. Der Weg ist schwerer zu lesen und fühlt sich weniger sicher an.',
    whyItMatters:
      'Gute Beleuchtung gehört zur alltäglichen Sicherheit im Quartier. Ein dunkler Schul- und Wohnweg betrifft nicht nur Komfort, sondern das Vertrauen in den öffentlichen Raum.',
    whoIsAffected:
      'Anwohnerinnen und Anwohner, Schülerinnen und Schüler, Abendgänger sowie alle, die diesen Fußweg zur Haltestelle nutzen.',
    latestUpdate: 'Das Signal bleibt lokal und offen. Derzeit liegt keine bestätigte Maßnahme vor.',
    statusLabel: 'Bürgerlicher Status: gemeldet — lokale Beobachtung',
    statusNote:
      '„Gemeldet“ heißt, dass das Thema lokal sichtbar gemacht wurde. Es bestätigt keine Reparatur, keine formale Übernahme und keinen Zeitplan.',
    observedLabel: 'Vor zwei Tagen gemeldet',
    observedOn: '2026-07-13',
    observedPrecision: 'day',
    authorDisplayName: 'Jonas Keller',
    imageKey: 'assets/feed/signal_porta_romana_lighting.jpg',
    imageFocusX: 58,
    imageFocusY: 40,
    publicationStatus: 'published',
    publishedAt: '2026-07-13T08:00:00.000Z',
    createdAt: '2026-07-13T08:00:00.000Z',
    updatedAt: '2026-07-13T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000203',
    communityId: '00000000-0000-4000-8000-000000000002',
    slug: 'munich-signal-3',
    position: 3,
    locale: 'de-DE',
    category: 'ÖFFENTLICHE BAUARBEITEN',
    area: 'Sendling',
    headline: 'Der provisorische Weg ist zu eng und schlecht ausgeschildert.',
    summary:
      'Fußgänger und Radfahrer teilen sich einen schmalen Durchgang. Es fehlen klare Hinweise und ein sicherer Übergang.',
    description:
      'Die Bauarbeiten haben den Durchgang auf einen engen provisorischen Weg verengt. Fußgänger und Radfahrer teilen sich denselben schmalen Raum, ohne klare Führung oder erkennbare Alternative.',
    whyItMatters:
      'Öffentliche Bauarbeiten gehören zum Stadtleben. Ohne verständliche Hinweise und sichere Übergänge wird der Alltag im Viertel jedoch unnötig unsicher und unklar.',
    whoIsAffected:
      'Fußgänger, Radfahrer, Anwohner in Sendling und alle, die das Gebiet regelmäßig durchqueren.',
    latestUpdate: 'Das Signal bleibt lokal und offen. Derzeit liegt keine bestätigte Maßnahme vor.',
    statusLabel: 'Bürgerlicher Status: offen — braucht lokale Klarheit',
    statusNote:
      '„Offen“ bedeutet, dass die Situation für die Gemeinschaft noch geklärt werden muss. Es bedeutet keine abgeschlossene behördliche Entscheidung.',
    observedLabel: 'Diese Woche beobachtet',
    observedOn: null,
    observedPrecision: 'week',
    authorDisplayName: 'Lukas Brandt',
    imageKey: 'assets/feed/signal_lorenteggio_works.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-07-12T08:00:00.000Z',
    createdAt: '2026-07-12T08:00:00.000Z',
    updatedAt: '2026-07-12T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000401',
    communityId: '00000000-0000-4000-8000-000000000003',
    slug: 'arad-signal-1',
    position: 1,
    locale: 'ro-RO',
    category: 'MEDIU',
    area: 'Pădurea Ceala',
    headline: 'Moloz depozitat ilegal la marginea pădurii Ceala',
    summary:
      'Camioane cu moloz ajung în continuare pe malul Mureșului, lângă pădurea Ceala. Traseul rămâne deschis, fără barieră.',
    description:
      'La capătul străzii Mărului, în zona Alfa, transporturile de moloz continuă pe un traseu care trece inclusiv pe pista de biciclete, către malul Mureșului și marginea pădurii Ceala. Amenzile aplicate până acum nu au oprit depozitările, iar accesul camioanelor rămâne posibil în lipsa unei bariere.',
    whyItMatters:
      'Pădurea Ceala și malul Mureșului sunt printre puținele zone naturale de agrement ale orașului. Depozitarea necontrolată a molozului afectează peisajul, mediul și siguranța celor care folosesc pista de biciclete.',
    whoIsAffected:
      'Bicicliști, familii care se plimbă în zona Ceala, pescari, locuitorii cartierului Alfa și oricine folosește malul Mureșului pentru recreere.',
    latestUpdate: 'Semnalul rămâne local și deschis. O barieră de acces nu a fost încă instalată.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-07-20',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Arad',
    imageKey: 'assets/feed/arad_ceala_mures.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-07-20T08:00:00.000Z',
    createdAt: '2026-07-20T08:00:00.000Z',
    updatedAt: '2026-07-20T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000402',
    communityId: '00000000-0000-4000-8000-000000000003',
    slug: 'arad-signal-2',
    position: 2,
    locale: 'ro-RO',
    category: 'INFRASTRUCTURĂ',
    area: 'Petriș',
    headline: 'Lucrările la Drumul Regelui avansează pe tronsonul Petriș–Vața',
    summary:
      'Pe cei 4 km din județul Arad se construiesc ziduri de sprijin și fundații continue. Termen de finalizare: aprilie 2028.',
    description:
      'Pe sectorul arădean al Drumului Regelui, între Petriș și limita cu județul Hunedoara, constructorul execută aproximativ 2,5 kilometri de ziduri de sprijin și 1.900 de metri de fundații continue. Lucrările stabilizează versanții și lărgesc platforma drumului montan.',
    whyItMatters:
      'Drumul Regelui va lega modern județele Arad și Hunedoara și va deschide accesul către Munții Zărandului, pe unul dintre cele mai spectaculoase trasee panoramice din vestul României.',
    whoIsAffected:
      'Locuitorii comunei Petriș și ai zonei montane, șoferii care circulă între cele două județe, turiștii care vizitează Munții Zărandului.',
    latestUpdate:
      'Lucrările avansează în ritm susținut. Proiectul are termen de finalizare în aprilie 2028.',
    statusLabel: 'Stare civică: în lucru — intervenție publică în desfășurare',
    statusNote:
      '„În lucru” înseamnă că o intervenție publică este în desfășurare, cu termen asumat. Semnalul urmărește evoluția lucrărilor.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-07-21',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Arad',
    imageKey: 'assets/feed/arad_drumul_regelui.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-07-21T08:00:00.000Z',
    createdAt: '2026-07-21T08:00:00.000Z',
    updatedAt: '2026-07-21T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000403',
    communityId: '00000000-0000-4000-8000-000000000003',
    slug: 'arad-signal-3',
    position: 3,
    locale: 'ro-RO',
    category: 'SPAȚIU PUBLIC',
    area: 'Strada Someșului',
    headline: 'Strada Someșului rămâne neasfaltată, în ciuda unei sentințe definitive',
    summary:
      'Instanța a obligat Primăria să asfalteze strada. Trotuarele au fost realizate; carosabilul, încă nu.',
    description:
      'Strada Someșului este în continuare din pământ, deși o sentință definitivă din 2024 obligă Primăria la asfaltare și amenajarea trotuarelor. Trotuarele au fost realizate anul trecut; partea carosabilă așteaptă încă documentația tehnică și execuția.',
    whyItMatters:
      'O stradă de pământ într-o zonă cu impozite calculate pentru infrastructură completă ridică o întrebare simplă de echitate: locuitorii plătesc pentru condiții pe care nu le au.',
    whoIsAffected:
      'Locuitorii străzii Someșului și ai zonei — pietoni, familii, șoferi care folosesc zilnic o stradă fără asfalt, pe orice vreme.',
    latestUpdate:
      'Primăria a comunicat că strada este inclusă pe lista de asfaltare, investiția fiind în etapa documentației tehnico-economice.',
    statusLabel: 'Stare civică: observat — hotărâre judecătorească în așteptarea executării',
    statusNote:
      'Semnalul privește o obligație stabilită printr-o hotărâre judecătorească definitivă, a cărei executare este încă în curs.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-07-21',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Arad',
    imageKey: 'assets/feed/arad_strada_somesului.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-07-21T08:00:00.000Z',
    createdAt: '2026-07-21T08:00:00.000Z',
    updatedAt: '2026-07-21T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000501',
    communityId: '00000000-0000-4000-8000-000000000004',
    slug: 'cluj-napoca-signal-1',
    position: 1,
    locale: 'ro-RO',
    category: 'MEDIU',
    area: 'Zorilor',
    headline: 'Spațiul verde din Parcul Rozelor, năpădit de vegetație necontrolată',
    summary:
      'Iarba și tufișurile netunse de peste două luni acoperă aleile secundare. Locuitorii cer reluarea programului de întreținere.',
    description:
      'În Parcul Rozelor din cartierul Zorilor, aleile secundare sunt acoperite de vegetație netunsă încă de la începutul verii. Băncile și coșurile de gunoi devin greu accesibile, iar iarba înaltă ascunde denivelările terenului.',
    whyItMatters:
      'Parcul Rozelor este unul dintre puținele spații verzi extinse din Zorilor, folosit zilnic de familii, sportivi și persoane în vârstă. Lipsa întreținerii reduce siguranța și utilitatea unui spațiu public esențial pentru cartier.',
    whoIsAffected:
      'Familii cu copii, persoane în vârstă, sportivi și locuitorii cartierului Zorilor care folosesc parcul pentru plimbări zilnice.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu există încă o confirmare a reluării programului de întreținere.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-03',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Cluj-Napoca',
    imageKey: 'assets/feed/cluj_napoca_parcul_rozelor.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-03T08:00:00.000Z',
    createdAt: '2026-08-03T08:00:00.000Z',
    updatedAt: '2026-08-03T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000502',
    communityId: '00000000-0000-4000-8000-000000000004',
    slug: 'cluj-napoca-signal-2',
    position: 2,
    locale: 'ro-RO',
    category: 'INFRASTRUCTURĂ',
    area: 'Mănăștur',
    headline: 'Carosabilul de pe strada Fabricii de Zahăr rămâne plin de gropi',
    summary:
      'Denivelările s-au adâncit după ploile din iulie. Autobuzele de transport public evită acum banda din dreapta.',
    description:
      'Pe strada Fabricii de Zahăr, în Mănăștur, mai multe gropi extinse afectează ambele benzi de circulație. Ploile din iulie au adâncit denivelările existente, iar șoferii de autobuz raportează că evită banda din dreapta pe tot traseul.',
    whyItMatters:
      'Strada este un traseu zilnic pentru transportul public și pentru mii de locuitori ai celui mai populat cartier al orașului. Gropile adânci cresc riscul de accidente și uzura prematură a vehiculelor.',
    whoIsAffected:
      'Locuitorii cartierului Mănăștur, pasagerii liniilor de autobuz care circulă pe strada Fabricii de Zahăr, bicicliști și șoferi.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu a fost confirmată încă o dată pentru lucrări de reparație.',
    statusLabel: 'Stare civică: semnalat — monitorizare locală',
    statusNote:
      '„Semnalat” indică faptul că problema a fost adusă la cunoștința comunității locale. Nu confirmă reparație, preluare formală sau termene de intervenție.',
    observedLabel: 'Semnalat acum două zile',
    observedOn: '2026-08-01',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Cluj-Napoca',
    imageKey: 'assets/feed/cluj_napoca_fabricii_de_zahar.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-01T08:00:00.000Z',
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000503',
    communityId: '00000000-0000-4000-8000-000000000004',
    slug: 'cluj-napoca-signal-3',
    position: 3,
    locale: 'ro-RO',
    category: 'SPAȚIU PUBLIC',
    area: 'Centrul Vechi',
    headline: 'Zona pietonală din jurul Bisericii Sfântul Mihail, blocată de terase neautorizate',
    summary:
      'Mese și scaune ocupă trotuarul pe o lățime de peste doi metri. Persoanele cu cărucior sau cu mobilitate redusă sunt nevoite să coboare pe carosabil.',
    description:
      'În jurul Pieței Unirii, mai multe terase depășesc perimetrul autorizat și ocupă trotuarul aproape în întregime, în special seara. Spațiul pietonal rămas este insuficient pentru fluxul de trecere, mai ales în zilele de weekend.',
    whyItMatters:
      'Centrul Vechi este cea mai circulată zonă pietonală a orașului. Un trotuar blocat afectează direct accesibilitatea pentru persoane cu cărucioare, cărucioare de copii sau mobilitate redusă.',
    whoIsAffected:
      'Persoane cu mobilitate redusă, părinți cu cărucioare, turiști și locuitorii care traversează zilnic Piața Unirii pe jos.',
    latestUpdate:
      'Semnalul rămâne deschis. Nu există încă o verificare confirmată a respectării perimetrelor autorizate.',
    statusLabel: 'Stare civică: deschis — necesită clarificare locală',
    statusNote:
      '„Deschis” înseamnă că situația rămâne de clarificat pentru comunitate. Nu implică o decizie administrativă deja încheiată.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-04',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Cluj-Napoca',
    imageKey: 'assets/feed/cluj_napoca_centrul_vechi.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-04T08:00:00.000Z',
    createdAt: '2026-08-04T08:00:00.000Z',
    updatedAt: '2026-08-04T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000601',
    communityId: '00000000-0000-4000-8000-000000000005',
    slug: 'sibiu-signal-1',
    position: 1,
    locale: 'ro-RO',
    category: 'SPAȚIU PUBLIC',
    area: 'Piața Mică',
    headline: 'Pavajul istoric din Piața Mică s-a deplasat lângă Pasajul Scărilor',
    summary:
      'Câteva zeci de pietre de pavaj s-au ridicat și s-au deplasat. Zona rămâne instabilă la pas, mai ales pe timp de ploaie.',
    description:
      'Lângă intrarea în Pasajul Scărilor, o porțiune din pavajul istoric al Pieței Mici s-a deplasat, lăsând pietre ridicate și goluri între ele. Traficul pietonal intens din zonă, combinat cu ploile de vară, a accelerat degradarea.',
    whyItMatters:
      'Piața Mică este inima turistică și pietonală a orașului, traversată zilnic de mii de locuitori și vizitatori. Pavajul instabil crește riscul de accidentare, în special pentru persoanele în vârstă.',
    whoIsAffected:
      'Locuitorii din Centrul Istoric, comercianții din piață, turiștii și persoanele în vârstă care traversează zona zilnic.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu este confirmată încă o intervenție de refacere a pavajului.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-02',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Sibiu',
    imageKey: 'assets/feed/sibiu_piata_mica.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-02T08:00:00.000Z',
    createdAt: '2026-08-02T08:00:00.000Z',
    updatedAt: '2026-08-02T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000602',
    communityId: '00000000-0000-4000-8000-000000000005',
    slug: 'sibiu-signal-2',
    position: 2,
    locale: 'ro-RO',
    category: 'INFRASTRUCTURĂ',
    area: 'Hipodrom',
    headline: 'Stâlpii de iluminat din cartierul Hipodrom III rămân stinși de trei săptămâni',
    summary:
      'Un tronson de aproape un kilometru pe strada Ceferiștilor este întunecat seara. Locuitorii au depus deja o sesizare la Primărie.',
    description:
      'Pe strada Ceferiștilor, în cartierul Hipodrom III, un tronson de aproape un kilometru rămâne fără iluminat public de la începutul lunii. Locuitorii spun că problema a fost deja semnalată furnizorului de energie, fără o dată clară de remediere.',
    whyItMatters:
      'Iluminatul public face parte din siguranța zilnică a unui cartier rezidențial dens. Un tronson întunecat afectează atât siguranța pietonilor, cât și percepția generală de siguranță a zonei.',
    whoIsAffected:
      'Locuitorii cartierului Hipodrom III, elevi care se întorc seara de la activități, persoane care folosesc strada Ceferiștilor pentru a ajunge la stațiile de transport public.',
    latestUpdate:
      'Locuitorii confirmă că au depus deja o sesizare. Semnalul rămâne în monitorizare locală.',
    statusLabel: 'Stare civică: semnalat — monitorizare locală',
    statusNote:
      '„Semnalat” indică faptul că problema a fost adusă la cunoștința comunității locale. Nu confirmă reparație, preluare formală sau termene de intervenție.',
    observedLabel: 'Semnalat acum trei săptămâni',
    observedOn: '2026-07-17',
    observedPrecision: 'week',
    authorDisplayName: 'Redacția TOWN Sibiu',
    imageKey: 'assets/feed/sibiu_hipodrom_iluminat.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-07-17T08:00:00.000Z',
    createdAt: '2026-07-17T08:00:00.000Z',
    updatedAt: '2026-07-17T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000603',
    communityId: '00000000-0000-4000-8000-000000000005',
    slug: 'sibiu-signal-3',
    position: 3,
    locale: 'ro-RO',
    category: 'MEDIU',
    area: 'Pădurea Dumbrava',
    headline: 'Cărările din Pădurea Dumbrava, blocate de crengi căzute după furtuna din iulie',
    summary:
      'Mai multe cărări principale spre Zoo și Muzeul Astra rămân impracticabile. Curățarea nu a fost încă anunțată.',
    description:
      'Furtuna puternică din a doua jumătate a lunii iulie a doborât mai multe crengi mari pe cărările principale din Pădurea Dumbrava, blocând accesul pietonal spre zona Zoo și spre traseele care duc către Muzeul Astra.',
    whyItMatters:
      'Pădurea Dumbrava este cea mai folosită zonă de agrement din apropierea orașului, vizitată zilnic de familii, alergători și turiști. Cărările blocate reduc accesul la un spațiu natural esențial pentru comunitate.',
    whoIsAffected:
      'Familii care vizitează Zoo, alergători, turiști care merg spre Muzeul Astra și locuitorii din apropiere care folosesc pădurea pentru plimbări zilnice.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu a fost anunțată încă o dată pentru curățarea cărărilor afectate.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-05',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Sibiu',
    imageKey: 'assets/feed/sibiu_padurea_dumbrava.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-05T08:00:00.000Z',
    createdAt: '2026-08-05T08:00:00.000Z',
    updatedAt: '2026-08-05T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000701',
    communityId: '00000000-0000-4000-8000-000000000006',
    slug: 'iasi-signal-1',
    position: 1,
    locale: 'ro-RO',
    category: 'INFRASTRUCTURĂ',
    area: 'Tătărași',
    headline: 'Asfaltul de pe strada Moara de Vânt s-a surpat pe o porțiune de zece metri',
    summary:
      'O conductă de apă spartă a subminat carosabilul. Circulația pe bandă unică este dirijată manual de un agent de pază local.',
    description:
      'Pe strada Moara de Vânt, în Tătărași, o avarie la conducta de apă a dus la surparea asfaltului pe o porțiune de aproximativ zece metri. Circulația se desfășoară pe o singură bandă, iar în orele de vârf apar ambuteiaje.',
    whyItMatters:
      'Strada Moara de Vânt este un traseu principal de acces spre zona rezidențială Tătărași. Surparea carosabilului reprezintă un pericol real pentru vehicule și pietoni deopotrivă.',
    whoIsAffected:
      'Locuitorii cartierului Tătărași, șoferii care folosesc strada ca rută zilnică, pietonii care traversează zona.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu este confirmată încă o dată pentru repararea conductei și a carosabilului.',
    statusLabel: 'Stare civică: semnalat — monitorizare locală',
    statusNote:
      '„Semnalat” indică faptul că problema a fost adusă la cunoștința comunității locale. Nu confirmă reparație, preluare formală sau termene de intervenție.',
    observedLabel: 'Semnalat ieri',
    observedOn: '2026-08-06',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Iași',
    imageKey: 'assets/feed/iasi_moara_de_vant.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-06T08:00:00.000Z',
    createdAt: '2026-08-06T08:00:00.000Z',
    updatedAt: '2026-08-06T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000702',
    communityId: '00000000-0000-4000-8000-000000000006',
    slug: 'iasi-signal-2',
    position: 2,
    locale: 'ro-RO',
    category: 'SPAȚIU PUBLIC',
    area: 'Copou',
    headline: 'Aleea principală din Parcul Copou rămâne fără bănci funcționale',
    summary:
      'Majoritatea băncilor de pe aleea centrală au scândurile rupte sau lipsă. Vizitatorii se așază pe marginea aleii.',
    description:
      'Pe aleea principală a Parcului Copou, aproape de Teiul lui Eminescu, majoritatea băncilor au scândurile rupte sau complet lipsă. Vizitatorii, mai ales persoanele în vârstă, se văd nevoiți să se așeze pe marginea aleii sau pe iarbă.',
    whyItMatters:
      'Parcul Copou este un reper istoric și un spațiu de recreere folosit zilnic de mii de ieșeni. Lipsa mobilierului urban funcțional reduce accesibilitatea unui spațiu public esențial pentru oraș.',
    whoIsAffected:
      'Persoane în vârstă, familii cu copii, studenți din campusurile din apropiere și turiști care vizitează Teiul lui Eminescu.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu există încă o confirmare a înlocuirii mobilierului urban.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-04',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Iași',
    imageKey: 'assets/feed/iasi_parcul_copou.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-04T08:00:00.000Z',
    createdAt: '2026-08-04T08:00:00.000Z',
    updatedAt: '2026-08-04T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000703',
    communityId: '00000000-0000-4000-8000-000000000006',
    slug: 'iasi-signal-3',
    position: 3,
    locale: 'ro-RO',
    category: 'MEDIU',
    area: 'Nicolina',
    headline: 'Malul Bahluiului din Nicolina, acoperit de deșeuri aduse de apele mari',
    summary:
      'Apele crescute din iulie au împins gunoaie și resturi vegetale pe mal. Mirosul afectează blocurile din apropiere.',
    description:
      'Pe malul Bahluiului, în dreptul cartierului Nicolina, creșterea nivelului apei din iulie a împins pe mal cantități mari de deșeuri plutitoare și resturi vegetale. Zona nu a fost curățată de la momentul retragerii apelor.',
    whyItMatters:
      'Malul Bahluiului este folosit ca traseu pietonal și de agrement pentru locuitorii din Nicolina. Deșeurile acumulate afectează atât mediul, cât și calitatea vieții în blocurile din apropiere.',
    whoIsAffected:
      'Locuitorii blocurilor din apropierea malului, persoane care folosesc traseul pietonal de-a lungul Bahluiului, familii cu copii.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu este confirmată încă o dată pentru operațiunea de curățare.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-05',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Iași',
    imageKey: 'assets/feed/iasi_malul_bahluiului.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-05T08:00:00.000Z',
    createdAt: '2026-08-05T08:00:00.000Z',
    updatedAt: '2026-08-05T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000801',
    communityId: '00000000-0000-4000-8000-000000000007',
    slug: 'timisoara-signal-1',
    position: 1,
    locale: 'ro-RO',
    category: 'SPAȚIU PUBLIC',
    area: 'Iosefin',
    headline: 'Trotuarul din fața Gării de Nord rămâne blocat de biciclete abandonate',
    summary:
      'Peste zece biciclete fără roți sau șa stau prinse de gard de luni de zile. Spațiul pietonal s-a redus la jumătate.',
    description:
      'În fața Gării de Nord, dinspre Iosefin, mai multe biciclete abandonate — unele fără roți, altele fără șa — ocupă gardul și trotuarul de câteva luni. Spațiul rămas pentru pietoni s-a redus considerabil, mai ales în orele de vârf ale traficului feroviar.',
    whyItMatters:
      'Zona Gării de Nord este un punct intens de tranzit zilnic pentru navetiști și călători. Un trotuar blocat afectează direct fluxul pietonal într-una dintre cele mai aglomerate zone ale orașului.',
    whoIsAffected:
      'Navetiști, călători cu bagaje, persoane cu mobilitate redusă și locuitorii din Iosefin care trec zilnic prin zonă.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu este confirmată încă o operațiune de ridicare a bicicletelor abandonate.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-03',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Timișoara',
    imageKey: 'assets/feed/timisoara_gara_de_nord.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-03T08:00:00.000Z',
    createdAt: '2026-08-03T08:00:00.000Z',
    updatedAt: '2026-08-03T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000802',
    communityId: '00000000-0000-4000-8000-000000000007',
    slug: 'timisoara-signal-2',
    position: 2,
    locale: 'ro-RO',
    category: 'INFRASTRUCTURĂ',
    area: 'Fabric',
    headline:
      'Pista de biciclete de pe strada Take Ionescu se întrerupe brusc lângă intersecția cu Circumvalațiunii',
    summary:
      'Marcajul dispare fără avertisment, iar bicicliștii sunt nevoiți să intre direct în traficul auto.',
    description:
      'Pe strada Take Ionescu, în apropierea intersecției cu Circumvalațiunii, pista de biciclete se întrerupe brusc, fără o zonă de tranziție marcată. Bicicliștii care circulă spre centru sunt nevoiți să intre direct pe banda auto, fără avertisment vizual pentru șoferi.',
    whyItMatters:
      'Take Ionescu este una dintre principalele artere folosite de bicicliști pentru a ajunge în centrul orașului. O întrerupere neclară a pistei crește riscul de accident chiar la intrarea într-o intersecție aglomerată.',
    whoIsAffected:
      'Bicicliști navetiști, elevi și studenți care folosesc bicicleta zilnic, șoferii care circulă pe Take Ionescu.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu este confirmată încă o soluție de continuare sau marcare a pistei.',
    statusLabel: 'Stare civică: semnalat — monitorizare locală',
    statusNote:
      '„Semnalat” indică faptul că problema a fost adusă la cunoștința comunității locale. Nu confirmă reparație, preluare formală sau termene de intervenție.',
    observedLabel: 'Semnalat acum o săptămână',
    observedOn: '2026-07-31',
    observedPrecision: 'week',
    authorDisplayName: 'Redacția TOWN Timișoara',
    imageKey: 'assets/feed/timisoara_take_ionescu.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-07-31T08:00:00.000Z',
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000803',
    communityId: '00000000-0000-4000-8000-000000000007',
    slug: 'timisoara-signal-3',
    position: 3,
    locale: 'ro-RO',
    category: 'MEDIU',
    area: 'Pădurea Verde',
    headline: 'Zona de picnic din Pădurea Verde rămâne fără coșuri de gunoi funcționale',
    summary:
      'Coșurile existente sunt pline sau răsturnate de câteva săptămâni. Deșeurile se acumulează în jurul meselor de picnic.',
    description:
      'În zona de picnic din Pădurea Verde, coșurile de gunoi existente sunt fie pline la capacitate, fie răsturnate, de câteva săptămâni. Deșeurile se acumulează în jurul meselor de picnic, mai ales după weekendurile aglomerate.',
    whyItMatters:
      'Pădurea Verde este principalul spațiu de agrement de la marginea orașului, folosit intens vara de familii și grupuri. Lipsa gestionării deșeurilor afectează atât igiena, cât și atractivitatea zonei.',
    whoIsAffected:
      'Familii care vin la picnic, alergători și cicliști care folosesc traseele din pădure, locuitorii din apropiere.',
    latestUpdate:
      'Semnalul rămâne local și deschis. Nu este confirmată încă o dată pentru golirea și înlocuirea coșurilor.',
    statusLabel: 'Stare civică: observat — în așteptarea atenției locale',
    statusNote:
      '„Observat” înseamnă că problema a fost recunoscută de comunitatea locală. Nu implică o procedură oficială și nici o intervenție deja începută.',
    observedLabel: 'Observat săptămâna aceasta',
    observedOn: '2026-08-06',
    observedPrecision: 'day',
    authorDisplayName: 'Redacția TOWN Timișoara',
    imageKey: 'assets/feed/timisoara_padurea_verde.jpg',
    imageFocusX: 50,
    imageFocusY: 45,
    publicationStatus: 'published',
    publishedAt: '2026-08-06T08:00:00.000Z',
    createdAt: '2026-08-06T08:00:00.000Z',
    updatedAt: '2026-08-06T08:00:00.000Z',
  },
] as const satisfies readonly CanonicalSignal[];

export const FOUNDATION_COMMUNITY_IDS = {
  milanoIt: '00000000-0000-4000-8000-000000000001',
  munichDe: '00000000-0000-4000-8000-000000000002',
  aradRo: '00000000-0000-4000-8000-000000000003',
  clujNapocaRo: '00000000-0000-4000-8000-000000000004',
  sibiuRo: '00000000-0000-4000-8000-000000000005',
  iasiRo: '00000000-0000-4000-8000-000000000006',
  timisoaraRo: '00000000-0000-4000-8000-000000000007',
} as const;

export const FOUNDATION_SIGNAL_IDS = {
  milanoSignal1: '00000000-0000-4000-8000-000000000101',
  milanoSignal2: '00000000-0000-4000-8000-000000000102',
  milanoSignal3: '00000000-0000-4000-8000-000000000103',
  munichSignal1: '00000000-0000-4000-8000-000000000201',
  munichSignal2: '00000000-0000-4000-8000-000000000202',
  munichSignal3: '00000000-0000-4000-8000-000000000203',
  aradSignal1: '00000000-0000-4000-8000-000000000401',
  aradSignal2: '00000000-0000-4000-8000-000000000402',
  aradSignal3: '00000000-0000-4000-8000-000000000403',
  clujNapocaSignal1: '00000000-0000-4000-8000-000000000501',
  clujNapocaSignal2: '00000000-0000-4000-8000-000000000502',
  clujNapocaSignal3: '00000000-0000-4000-8000-000000000503',
  sibiuSignal1: '00000000-0000-4000-8000-000000000601',
  sibiuSignal2: '00000000-0000-4000-8000-000000000602',
  sibiuSignal3: '00000000-0000-4000-8000-000000000603',
  iasiSignal1: '00000000-0000-4000-8000-000000000701',
  iasiSignal2: '00000000-0000-4000-8000-000000000702',
  iasiSignal3: '00000000-0000-4000-8000-000000000703',
  timisoaraSignal1: '00000000-0000-4000-8000-000000000801',
  timisoaraSignal2: '00000000-0000-4000-8000-000000000802',
  timisoaraSignal3: '00000000-0000-4000-8000-000000000803',
} as const;
