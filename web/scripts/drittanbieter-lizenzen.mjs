// Sammelt beim Docker-Build die Lizenztexte aller npm-Pakete, die im
// ausgelieferten Frontend landen können (alle Nicht-Entwicklungspakete laut
// package-lock.json), in eine Textdatei. Das Runtime-Image enthält nur das
// gebaute Frontend ohne node_modules; ohne diese Datei gingen die Lizenztexte
// beim Ausliefern verloren.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [, , ziel] = process.argv;
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const LIZENZDATEI = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

const abschnitte = [];
for (const [pfad, eintrag] of Object.entries(lock.packages)) {
  if (!pfad.startsWith('node_modules/') || eintrag.dev) continue;
  let paket;
  try {
    paket = JSON.parse(readFileSync(path.join(pfad, 'package.json'), 'utf8'));
  } catch {
    continue; // optionale Pakete anderer Plattformen sind nicht installiert
  }
  const texte = readdirSync(pfad)
    .filter((name) => LIZENZDATEI.test(name))
    .sort()
    .map((name) => readFileSync(path.join(pfad, name), 'utf8').trim());
  const lizenz = typeof paket.license === 'string' ? paket.license : JSON.stringify(paket.license ?? 'unbekannt');
  abschnitte.push({
    titel: `${paket.name} ${paket.version} (${lizenz})`,
    text: texte.length ? texte.join('\n\n') : '(Das Paket enthält keine eigene Lizenzdatei.)',
  });
}
abschnitte.sort((a, b) => a.titel.localeCompare(b.titel));

const kopf = 'postbuch.net – Lizenztexte der im Web-Frontend enthaltenen npm-Pakete\n'
  + 'Diese Datei wird beim Build automatisch aus node_modules erzeugt.\n';
const inhalt = [kopf, ...abschnitte.map((a) => `${'='.repeat(72)}\n${a.titel}\n${'='.repeat(72)}\n\n${a.text}\n`)].join('\n');
mkdirSync(path.dirname(ziel), { recursive: true });
writeFileSync(ziel, inhalt);
console.log(`${abschnitte.length} Pakete → ${ziel}`);
