/**
 * lib/net-heuristics.js – „sieht diese Adresse nach dem eigenen Netz aus?"
 *
 * Ausschließlich für Warntexte und Formular-Logik im UI. Die verbindliche
 * Prüfung sitzt serverseitig in `app/src/lib/net-guard.js`, das vor jedem
 * Verbindungsaufbau real auflöst und gegen die geprüfte IP verbindet. Hier
 * geht es nur darum, ob ein Hinweis eingeblendet wird – deshalb reicht die
 * Namensform, und deshalb ist ein Fehlurteil hier folgenlos.
 *
 * Stand vorher doppelt in NextcloudCard und wäre mit dem Provider-Dialog ein
 * drittes Mal entstanden.
 */
export function wirktPrivat(rawUrl) {
  if (!rawUrl) return false;
  try {
    const h = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost' || h === '::1') return true;
    if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.internal')) return true;
    // Docker-Bridge zum Host – der Standardweg zu einem Ollama auf demselben Gerät.
    if (h === 'host.docker.internal' || h === 'gateway.docker.internal') return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
    const m = h.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    // IPv6 ULA (fc00::/7) und Link-Local.
    if (/^f[cd]/.test(h) || h.startsWith('fe8')) return true;
    // Ein reiner Hostname ohne Punkt ist praktisch immer ein Name im eigenen Netz.
    if (!h.includes('.') && !/^\d+$/.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}
