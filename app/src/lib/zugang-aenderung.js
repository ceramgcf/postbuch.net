/**
 * Prüft Änderungen, die den Zugriff eines Menschen betreffen.
 * Auch eine Aktivierung/Deaktivierung muss bestehende Sessions widerrufen.
 */
export function istZugangsAenderung({ alt, neu, loginRename = false, passwordHash }) {
  return loginRename
    || neu.loginfaehig !== alt.loginfaehig
    || neu.aktiv !== alt.aktiv
    || neu.rolle !== alt.rolle
    || neu.lesebereich !== alt.lesebereich
    || passwordHash !== alt.password_hash;
}
