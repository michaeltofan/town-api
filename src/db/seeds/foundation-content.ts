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
    latestUpdate:
      'Semnalul rămâne local și deschis. O barieră de acces nu a fost încă instalată.',
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
] as const satisfies readonly CanonicalSignal[];

export const FOUNDATION_COMMUNITY_IDS = {
  milanoIt: '00000000-0000-4000-8000-000000000001',
  munichDe: '00000000-0000-4000-8000-000000000002',
  aradRo: '00000000-0000-4000-8000-000000000003',
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
} as const;
