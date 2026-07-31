import type { SupportedLocale } from './policy.js';

export type RecoveryEmailContent = {
  subject: string;
  text: string;
};

/**
 * Plain-text account recovery email copy. No HTML, no templating engine.
 * Explains access recovery (not password reset). Locale must already be SupportedLocale.
 */
export function buildRecoveryEmail(
  locale: SupportedLocale,
  input: { code: string; expiresAt: string },
): RecoveryEmailContent {
  switch (locale) {
    case 'it':
      return {
        subject: 'Codice di recupero accesso TOWN',
        text: [
          'Usa questo codice per recuperare l’accesso al tuo account TOWN.',
          '',
          `Codice: ${input.code}`,
          '',
          `Scade alle ${input.expiresAt} (valido 10 minuti).`,
          'Non condividere questo codice con nessuno.',
          'Questo non reimposta una password e non ti autentica automaticamente.',
        ].join('\n'),
      };
    case 'de':
      return {
        subject: 'TOWN-Code zur Zugangs-Wiederherstellung',
        text: [
          'Verwende diesen Code, um den Zugang zu deinem TOWN-Konto wiederherzustellen.',
          '',
          `Code: ${input.code}`,
          '',
          `Er läuft ab um ${input.expiresAt} (10 Minuten gültig).`,
          'Teile diesen Code mit niemandem.',
          'Dies setzt kein Passwort zurück und meldet dich nicht automatisch an.',
        ].join('\n'),
      };
    case 'en':
    default:
      return {
        subject: 'TOWN account access recovery code',
        text: [
          'Use this code to recover access to your TOWN account.',
          '',
          `Code: ${input.code}`,
          '',
          `It expires at ${input.expiresAt} (valid for 10 minutes).`,
          'Do not share this code with anyone.',
          'This does not reset a password and does not sign you in automatically.',
        ].join('\n'),
      };
  }
}
