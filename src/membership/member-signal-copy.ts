/**
 * Localized editorial scaffolding for member-published signals.
 * Members supply title + description + category + photo; these fill required
 * civic detail fields without inventing a separate approval workflow.
 */

export function memberSignalEditorialCopy(locale: string): {
  whyItMatters: string;
  whoIsAffected: string;
  latestUpdate: string;
  statusLabel: string;
  statusNote: string;
  observedLabel: string;
} {
  if (locale.startsWith('de')) {
    return {
      whyItMatters:
        'Dieses lokale Problem wurde von einem Mitglied der Gemeinschaft gemeldet und verdient öffentliche Aufmerksamkeit vor Ort.',
      whoIsAffected: 'Anwohnerinnen und Anwohner sowie alle, die diesen Ort im Alltag nutzen.',
      latestUpdate: 'Vom Mitglied veröffentlicht — noch keine weitere lokale Bestätigung.',
      statusLabel: 'Bürgerstatus: von einem Mitglied gemeldet',
      statusNote:
        '„Gemeldet“ bedeutet, dass ein Mitglied das Problem unter eigenem Namen veröffentlicht hat. Es bestätigt weder eine behördliche Akte noch einen bereits begonnenen Eingriff.',
      observedLabel: 'Heute gemeldet',
    };
  }
  if (locale.startsWith('ro')) {
    return {
      whyItMatters:
        'Această problemă locală a fost semnalată de un membru al comunității și merită atenție publică aici.',
      whoIsAffected: 'Locuitorii și toți cei care folosesc zilnic acest loc.',
      latestUpdate: 'Publicat de un membru — fără altă confirmare locală încă.',
      statusLabel: 'Stare civică: semnalat de un membru',
      statusNote:
        '„Semnalat” înseamnă că un membru a publicat problema sub numele său real. Nu confirmă un dosar oficial și nici un intervenție deja începută.',
      observedLabel: 'Semnalat astăzi',
    };
  }
  return {
    whyItMatters:
      'Questo problema locale è stato segnalato da un membro della comunità e merita attenzione pubblica qui.',
    whoIsAffected: 'I residenti e chi usa questo luogo nella vita quotidiana.',
    latestUpdate: 'Pubblicato da un membro — nessuna altra conferma locale ancora.',
    statusLabel: 'Stato civico: segnalato da un membro',
    statusNote:
      '«Segnalato» significa che un membro ha pubblicato il problema sotto il proprio nome. Non conferma una pratica ufficiale né un intervento già avviato.',
    observedLabel: 'Segnalato oggi',
  };
}
