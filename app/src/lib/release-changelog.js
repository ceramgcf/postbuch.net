/**
 * lib/release-changelog.js — Changelog-Teil des Release-Manifests
 *
 * Wer Versionen überspringt, soll im Update-Dialog alles sehen, was seit
 * seiner Version dazukam – nicht nur die Stichpunkte der neuesten. Dafür trägt
 * das Manifest neben `changelog` den `verlauf`: die letzten Versionen mit Datum
 * und Stichpunkten, neueste zuerst. Der Client zeigt daraus genau die
 * Versionen, die neuer sind als die installierte.
 *
 * `changelog` bleibt für Instanzen, die `verlauf` noch nicht kennen (der
 * Validator verwirft unbekannte Felder stillschweigend). Er fasst die ganze
 * Minor-Linie zusammen: Ein Patch-Release zeigt einer älteren Instanz sonst nur
 * seine Fehlerbehebungen, nicht die Neuerungen der zugehörigen x.y.0.
 *
 * Erzeugt wird beides von `scripts/gen-latest-json.mjs`; der Validator in
 * `lib/update-manifest.js` prüft die Grenzen hier. Ältere Clients lesen den
 * Feed mit höchstens 64 KB (`FEED_MAX_BYTES`) – das Budget unten hält das
 * Manifest deutlich darunter.
 */

import { vergleicheSemver } from './postbuch-feed.js';

export const MAX_CHANGELOG_EINTRAEGE = 40;
export const MAX_CHANGELOG_LAENGE = 200;
export const MAX_VERLAUF_VERSIONEN = 30;
/** Obergrenze für das serialisierte `verlauf`-Feld in Bytes. */
export const VERLAUF_BUDGET_BYTES = 32 * 1024;

const KOPF_RE = /^##\s+(\d{1,3}\.\d{1,3}\.\d{1,3})\s+–\s+(\d{4}-\d{2}-\d{2})\s*$/;

/**
 * Zerlegt CHANGELOG.md in Abschnitte `{ version, datum, punkte }`, in
 * Dateireihenfolge. Die Formatvorlage (`## <version> – <YYYY-MM-DD>`) passt
 * nicht auf das Muster und fällt heraus.
 */
export function parseChangelog(text) {
  const abschnitte = [];
  let aktuell = null;
  for (const zeile of String(text).split('\n')) {
    if (/^##\s/.test(zeile)) {
      const m = zeile.match(KOPF_RE);
      aktuell = m ? { version: m[1], datum: m[2], punkte: [] } : null;
      if (aktuell) abschnitte.push(aktuell);
      continue;
    }
    const p = aktuell && zeile.match(/^[-*]\s+(.*\S)\s*$/);
    if (p) aktuell.punkte.push(p[1]);
  }
  return abschnitte;
}

function minorLinie(version) {
  return version.split('.').slice(0, 2).join('.');
}

/**
 * Baut `changelog` und `verlauf` für die angegebene Version.
 *
 * @param {Array<{version:string, datum:string, punkte:string[]}>} abschnitte
 * @param {string} version
 * @returns {{datum:string, changelog:string[], verlauf:Array<{version:string, datum:string, changelog:string[]}>}}
 * @throws {Error} wenn der Abschnitt der Version fehlt oder leer ist
 */
export function baueChangelog(abschnitte, version) {
  const eigener = abschnitte.find((a) => a.version === version);
  if (!eigener) {
    throw new Error(`CHANGELOG.md hat keinen Abschnitt "## ${version} – YYYY-MM-DD".`);
  }
  if (!eigener.punkte.length) {
    throw new Error(`Der Abschnitt "## ${version}" in CHANGELOG.md enthält keine Stichpunkte.`);
  }

  // Nur diese und ältere Versionen, neueste zuerst, jede nur einmal.
  const gesehen = new Set();
  const bisher = abschnitte
    .filter((a) => vergleicheSemver(a.version, version) <= 0 && a.punkte.length)
    .sort((a, b) => vergleicheSemver(b.version, a.version))
    .filter((a) => !gesehen.has(a.version) && gesehen.add(a.version));

  // Flache Liste für ältere Clients: die eigene Version, darunter die älteren
  // Versionen derselben Minor-Linie mit einer Zwischenzeile.
  const changelog = [...eigener.punkte];
  for (const a of bisher.filter((x) => x.version !== version && minorLinie(x.version) === minorLinie(version))) {
    if (changelog.length + 2 > MAX_CHANGELOG_EINTRAEGE) break;
    changelog.push(`Ebenfalls enthalten – neu in ${a.version}:`);
    for (const p of a.punkte) {
      if (changelog.length >= MAX_CHANGELOG_EINTRAEGE) break;
      changelog.push(p);
    }
  }
  if (changelog.length > MAX_CHANGELOG_EINTRAEGE) changelog.length = MAX_CHANGELOG_EINTRAEGE;

  const verlauf = [];
  let bytes = 2;
  for (const a of bisher.slice(0, MAX_VERLAUF_VERSIONEN)) {
    const eintrag = { version: a.version, datum: a.datum, changelog: a.punkte.slice(0, MAX_CHANGELOG_EINTRAEGE) };
    const groesse = Buffer.byteLength(JSON.stringify(eintrag)) + 1;
    // Die eigene Version steht immer drin; ältere nur, solange das Budget reicht.
    if (verlauf.length && bytes + groesse > VERLAUF_BUDGET_BYTES) break;
    verlauf.push(eintrag);
    bytes += groesse;
  }

  return { datum: eigener.datum, changelog, verlauf };
}

/**
 * Die Versionen aus `verlauf`, die neuer als `installiert` und höchstens
 * `verfuegbar` sind. Ohne bekannte installierte Version nur die neueste.
 */
export function verlaufSeit(verlauf, installiert, verfuegbar) {
  const liste = (verlauf || []).filter((v) => vergleicheSemver(v.version, verfuegbar) <= 0);
  if (!installiert) return liste.slice(0, 1);
  return liste.filter((v) => vergleicheSemver(v.version, installiert) > 0);
}
