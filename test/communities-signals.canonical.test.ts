import { describe, expect, it } from 'vitest';
import {
  FOUNDATION_COMMUNITIES,
  FOUNDATION_SIGNALS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';

describe('canonical foundation content lock', () => {
  it('locks community identifiers and metadata', () => {
    expect(FOUNDATION_COMMUNITIES).toHaveLength(22);
    expect(FOUNDATION_COMMUNITIES[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'milano-it',
      position: 1,
      countryCode: 'IT',
      cityName: 'Milano',
      displayName: 'Milano',
      defaultLocale: 'it-IT',
      timezone: 'Europe/Rome',
      status: 'active',
    });
    expect(FOUNDATION_COMMUNITIES[1]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000002',
      slug: 'munich-de',
      position: 2,
      countryCode: 'DE',
      cityName: 'Munich',
      displayName: 'München',
      defaultLocale: 'de-DE',
      timezone: 'Europe/Berlin',
      status: 'active',
    });
    expect(FOUNDATION_COMMUNITIES[2]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000003',
      slug: 'arad-ro',
      position: 3,
      countryCode: 'RO',
      cityName: 'Arad',
      displayName: 'Arad',
      defaultLocale: 'ro-RO',
      timezone: 'Europe/Bucharest',
      status: 'active',
    });
  });

  it('locks Italian, German, and Romanian signal identity and approved copy fields', () => {
    expect(FOUNDATION_SIGNALS).toHaveLength(66);

    const milanoOne = FOUNDATION_SIGNALS.find(
      (signal) => signal.id === FOUNDATION_SIGNAL_IDS.milanoSignal1,
    );
    expect(milanoOne).toMatchObject({
      slug: 'milano-signal-1',
      position: 1,
      locale: 'it-IT',
      category: 'SPAZIO PUBBLICO',
      area: 'Città Studi',
      headline: 'Marciapiede danneggiato davanti alla scuola di via Padova',
      authorDisplayName: 'Marta Rinaldi',
      observedLabel: 'Osservato ieri',
      imageKey: 'assets/feed/signal_citta_studi_pavement.jpg',
      imageFocusX: 50,
      imageFocusY: 42,
    });
    expect(milanoOne?.summary).toContain('Le radici hanno sollevato il marciapiede');
    expect(milanoOne?.description).toContain('via Padova');
    expect(milanoOne?.statusLabel).toContain('osservato');
    expect(milanoOne?.latestUpdate).toBe(
      'Il segnale resta locale e aperto. Nessun intervento confermato risulta al momento.',
    );

    const munichOne = FOUNDATION_SIGNALS.find(
      (signal) => signal.id === FOUNDATION_SIGNAL_IDS.munichSignal1,
    );
    expect(munichOne).toMatchObject({
      slug: 'munich-signal-1',
      position: 1,
      locale: 'de-DE',
      category: 'ÖFFENTLICHER RAUM',
      area: 'Schwabing',
      headline: 'Der Gehweg ist hier kaum noch sicher passierbar.',
      authorDisplayName: 'Anna Weber',
      observedLabel: 'Gestern beobachtet',
      imageKey: 'assets/feed/signal_citta_studi_pavement.jpg',
      imageFocusX: 50,
      imageFocusY: 42,
    });
    expect(munichOne?.summary).toContain('Unebene Platten');
    expect(munichOne?.statusNote).toContain('Beobachtet');
    expect(munichOne?.latestUpdate).toBe(
      'Das Signal bleibt lokal und offen. Derzeit liegt keine bestätigte Maßnahme vor.',
    );

    const aradOne = FOUNDATION_SIGNALS.find(
      (signal) => signal.id === FOUNDATION_SIGNAL_IDS.aradSignal1,
    );
    expect(aradOne).toMatchObject({
      slug: 'arad-signal-1',
      position: 1,
      locale: 'ro-RO',
      category: 'MEDIU',
      area: 'Pădurea Ceala',
      headline: 'Moloz depozitat ilegal la marginea pădurii Ceala',
      authorDisplayName: 'Redacția TOWN Arad',
      observedLabel: 'Observat săptămâna aceasta',
      imageKey: 'assets/feed/arad_ceala_mures.jpg',
      imageFocusX: 50,
      imageFocusY: 45,
    });
    expect(aradOne?.summary).toContain('Camioane cu moloz');
    expect(aradOne?.description).toContain('pădurii Ceala');

    for (const signal of FOUNDATION_SIGNALS) {
      expect(signal.latestUpdate).not.toMatch(/prototip|Prototyp/i);
      expect(JSON.stringify(signal)).not.toMatch(/prototip|Prototyp/i);
    }
  });

  it('locks the Romanian city-expansion communities and signal identity', () => {
    const clujCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'cluj-napoca-ro');
    const sibiuCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'sibiu-ro');
    const iasiCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'iasi-ro');
    const timisoaraCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'timisoara-ro');
    expect(clujCommunity).toMatchObject({
      position: 4,
      countryCode: 'RO',
      cityName: 'Cluj-Napoca',
      defaultLocale: 'ro-RO',
      timezone: 'Europe/Bucharest',
      status: 'active',
    });
    expect(sibiuCommunity).toMatchObject({
      position: 5,
      countryCode: 'RO',
      cityName: 'Sibiu',
    });
    expect(iasiCommunity).toMatchObject({
      position: 6,
      countryCode: 'RO',
      cityName: 'Iași',
    });
    expect(timisoaraCommunity).toMatchObject({
      position: 7,
      countryCode: 'RO',
      cityName: 'Timișoara',
    });

    const clujOne = FOUNDATION_SIGNALS.find(
      (signal) => signal.id === FOUNDATION_SIGNAL_IDS.clujNapocaSignal1,
    );
    expect(clujOne).toMatchObject({
      communityId: clujCommunity?.id,
      slug: 'cluj-napoca-signal-1',
      position: 1,
      locale: 'ro-RO',
      category: 'MEDIU',
      area: 'Zorilor',
    });

    for (const cityId of [
      FOUNDATION_SIGNAL_IDS.clujNapocaSignal1,
      FOUNDATION_SIGNAL_IDS.sibiuSignal1,
      FOUNDATION_SIGNAL_IDS.iasiSignal1,
      FOUNDATION_SIGNAL_IDS.timisoaraSignal1,
    ]) {
      const signal = FOUNDATION_SIGNALS.find((s) => s.id === cityId);
      expect(signal).toBeDefined();
      expect(signal?.locale).toBe('ro-RO');
      expect(signal?.publicationStatus).toBe('published');
    }
  });

  it('locks the German/Austrian city-expansion communities and signal identity', () => {
    const kolnCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'koln-de');
    const dortmundCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'dortmund-de');
    const stuttgartCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'stuttgart-de');
    const frankfurtCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'frankfurt-de');
    const salzburgCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'salzburg-at');
    expect(kolnCommunity).toMatchObject({
      position: 8,
      countryCode: 'DE',
      cityName: 'Koln',
      defaultLocale: 'de-DE',
      timezone: 'Europe/Berlin',
      status: 'active',
    });
    expect(dortmundCommunity).toMatchObject({
      position: 9,
      countryCode: 'DE',
      cityName: 'Dortmund',
    });
    expect(stuttgartCommunity).toMatchObject({
      position: 10,
      countryCode: 'DE',
      cityName: 'Stuttgart',
    });
    expect(frankfurtCommunity).toMatchObject({
      position: 11,
      countryCode: 'DE',
      cityName: 'Frankfurt',
    });
    expect(salzburgCommunity).toMatchObject({
      position: 12,
      countryCode: 'AT',
      cityName: 'Salzburg',
      defaultLocale: 'de-AT',
      timezone: 'Europe/Vienna',
    });

    const kolnOne = FOUNDATION_SIGNALS.find(
      (signal) => signal.id === FOUNDATION_SIGNAL_IDS.kolnSignal1,
    );
    expect(kolnOne).toMatchObject({
      communityId: kolnCommunity?.id,
      slug: 'koln-signal-1',
      position: 1,
      locale: 'de-DE',
      category: 'ÖFFENTLICHER RAUM',
      area: 'Ehrenfeld',
    });

    for (const cityId of [
      FOUNDATION_SIGNAL_IDS.kolnSignal1,
      FOUNDATION_SIGNAL_IDS.dortmundSignal1,
      FOUNDATION_SIGNAL_IDS.stuttgartSignal1,
      FOUNDATION_SIGNAL_IDS.frankfurtSignal1,
    ]) {
      const signal = FOUNDATION_SIGNALS.find((s) => s.id === cityId);
      expect(signal).toBeDefined();
      expect(signal?.locale).toBe('de-DE');
      expect(signal?.publicationStatus).toBe('published');
    }

    const salzburgOne = FOUNDATION_SIGNALS.find(
      (signal) => signal.id === FOUNDATION_SIGNAL_IDS.salzburgSignal1,
    );
    expect(salzburgOne).toBeDefined();
    expect(salzburgOne?.locale).toBe('de-AT');
    expect(salzburgOne?.publicationStatus).toBe('published');
  });
  it('locks the French and Hungarian foundation communities and locales', () => {
    expect(FOUNDATION_COMMUNITIES.slice(12, 17).map((community) => community.slug)).toEqual([
      'marseille-fr',
      'lyon-fr',
      'toulouse-fr',
      'budapest-hu',
      'szeged-hu',
    ]);
    expect(
      FOUNDATION_COMMUNITIES.slice(12, 15).every(
        (community) => community.defaultLocale === 'fr-FR',
      ),
    ).toBe(true);
    expect(
      FOUNDATION_COMMUNITIES.slice(15, 17).every(
        (community) => community.defaultLocale === 'hu-HU',
      ),
    ).toBe(true);
    expect(FOUNDATION_SIGNALS.filter((signal) => signal.locale === 'fr-FR')).toHaveLength(9);
    expect(FOUNDATION_SIGNALS.filter((signal) => signal.locale === 'hu-HU')).toHaveLength(6);
    expect(FOUNDATION_SIGNAL_IDS.marseilleSignal1).toBe('00000000-0000-4000-8000-000000001401');
    expect(FOUNDATION_SIGNAL_IDS.szegedSignal3).toBe('00000000-0000-4000-8000-000000001803');
  });

  it('locks the Spanish city-expansion communities and signal identity', () => {
    expect(FOUNDATION_COMMUNITIES.slice(-5).map((community) => community.slug)).toEqual([
      'madrid-es',
      'barcelona-es',
      'valencia-es',
      'sevilla-es',
      'malaga-es',
    ]);
    expect(
      FOUNDATION_COMMUNITIES.slice(17, 22).every(
        (community) => community.defaultLocale === 'es-ES',
      ),
    ).toBe(true);
    expect(
      FOUNDATION_COMMUNITIES.slice(17, 22).every((community) => community.countryCode === 'ES'),
    ).toBe(true);
    expect(
      FOUNDATION_COMMUNITIES.slice(17, 22).every(
        (community) => community.timezone === 'Europe/Madrid',
      ),
    ).toBe(true);

    const madridCommunity = FOUNDATION_COMMUNITIES.find((c) => c.slug === 'madrid-es');
    expect(madridCommunity).toMatchObject({
      position: 18,
      countryCode: 'ES',
      cityName: 'Madrid',
      defaultLocale: 'es-ES',
      timezone: 'Europe/Madrid',
      status: 'active',
    });

    const madridOne = FOUNDATION_SIGNALS.find(
      (signal) => signal.id === FOUNDATION_SIGNAL_IDS.madridSignal1,
    );
    expect(madridOne).toMatchObject({
      communityId: madridCommunity?.id,
      slug: 'madrid-signal-1',
      position: 1,
      locale: 'es-ES',
      category: 'ESPACIO PÚBLICO',
      area: 'Lavapiés',
    });

    for (const cityId of [
      FOUNDATION_SIGNAL_IDS.madridSignal1,
      FOUNDATION_SIGNAL_IDS.barcelonaSignal1,
      FOUNDATION_SIGNAL_IDS.valenciaSignal1,
      FOUNDATION_SIGNAL_IDS.sevillaSignal1,
      FOUNDATION_SIGNAL_IDS.malagaSignal1,
    ]) {
      const signal = FOUNDATION_SIGNALS.find((s) => s.id === cityId);
      expect(signal).toBeDefined();
      expect(signal?.locale).toBe('es-ES');
      expect(signal?.publicationStatus).toBe('published');
    }

    expect(FOUNDATION_SIGNALS.filter((signal) => signal.locale === 'es-ES')).toHaveLength(15);
    expect(FOUNDATION_SIGNAL_IDS.madridSignal1).toBe('00000000-0000-4000-8000-000000001901');
    expect(FOUNDATION_SIGNAL_IDS.malagaSignal3).toBe('00000000-0000-4000-8000-000000002303');
  });
});
