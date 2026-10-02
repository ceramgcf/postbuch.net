/**
 * Papierkorb-Verschiebung gelöschter Dokumente — eine Stelle für alle Löschpfade.
 *
 * Normale Dokumentlöschungen rufen diese Funktion vor dem DB-DELETE auf und
 * brechen bei `false` ab. Der Hintergrundlauf beim Löschen eines Menschen ruft
 * sie nach dem DB-COMMIT auf. Deshalb wirft der Ablage-Move nie an den Aufrufer,
 * sondern meldet den Erfolg als Boolean und protokolliert beide Fehlversuche.
 */
import { getAdapter } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';

export async function verschiebeInPapierkorb({ postid, storageId, storageBackend, betreff }) {
  if (!storageId) return true;
  const storage = getAdapter(storageBackend);
  try {
    await storage.moveToTrash(storageId, `[Gelöscht] ${(betreff || postid).slice(0, 60)} ${postid}.pdf`);
    return true;
  } catch (err) {
    // Fallback: mit einfacherem Namen versuchen (Sonderzeichen im Betreff)
    console.error(`[document-delete] Papierkorb fehlgeschlagen (${postid}): ${err.message}`);
    try {
      await storage.moveToTrash(storageId, `[Gelöscht] ${postid}.pdf`);
      return true;
    } catch (e2) {
      console.error(`[document-delete] Papierkorb-Fallback fehlgeschlagen (${postid}): ${e2.message}`);
      appLog('WARN', 'actions', `Datei konnte nicht in den Papierkorb verschoben werden: ${postid}`,
        { entity: 'postbuch', entityId: postid });
      return false;
    }
  }
}
