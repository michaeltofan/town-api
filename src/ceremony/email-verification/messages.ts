import type { SupportedLocale } from './policy.js';

export type VerificationEmailContent = {
  subject: string;
  text: string;
};

/**
 * Plain-text verification email copy. No HTML, no templating engine.
 * Locale must already be a SupportedLocale (callers use resolveLocale).
 */
export function buildVerificationEmail(
  locale: SupportedLocale,
  input: { code: string; expiresAt: string },
): VerificationEmailContent {
  switch (locale) {
    case 'it':
      return {
        subject: 'Il tuo codice di verifica TOWN',
        text: [
          `Il tuo codice di verifica TOWN è: ${input.code}`,
          '',
          `Scade alle ${input.expiresAt}.`,
          'Non condividere questo codice con nessuno.',
        ].join('\n'),
      };
    case 'de':
      return {
        subject: 'Dein TOWN-Bestätigungscode',
        text: [
          `Dein TOWN-Bestätigungscode lautet: ${input.code}`,
          '',
          `Er läuft ab um ${input.expiresAt}.`,
          'Teile diesen Code mit niemandem.',
        ].join('\n'),
      };
    case 'en':
    default:
      return {
        subject: 'Your TOWN verification code',
        text: [
          `Your TOWN verification code is: ${input.code}`,
          '',
          `It expires at ${input.expiresAt}.`,
          'Do not share this code with anyone.',
        ].join('\n'),
      };
  }
}
