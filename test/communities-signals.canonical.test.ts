import { describe, expect, it } from 'vitest';
import {
  FOUNDATION_COMMUNITIES,
  FOUNDATION_SIGNALS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';

describe('canonical foundation content lock', () => {
  it('locks community identifiers and metadata', () => {
    expect(FOUNDATION_COMMUNITIES).toHaveLength(2);
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
  });

  it('locks Italian and German signal identity and approved copy fields', () => {
    expect(FOUNDATION_SIGNALS).toHaveLength(6);

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

    for (const signal of FOUNDATION_SIGNALS) {
      expect(signal.latestUpdate).not.toMatch(/prototip|Prototyp/i);
      expect(JSON.stringify(signal)).not.toMatch(/prototip|Prototyp/i);
    }
  });
});
