/**
 * AufgabenUmstellungHinweis.jsx – Hinweis nach der Umstellung der einfachen
 * Modellwahl auf zwei Aufgabentypen
 *
 * Erscheint auf dem Dashboard (mit Link) und über der Modellauswahl in den
 * KI-Einstellungen, bis der Admin die beiden Aufgabentypen gespeichert hat.
 * Die Daten kommen aus `aufgabenUmstellung` im KI-Status (nur Admin-Variante),
 * geschrieben von app/src/service/aufgabentypen-umstellung.js.
 */
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';

const AUFGABEN = [
  { key: 'routine', label: 'Einfach & Routine' },
  { key: 'komplex', label: 'Anspruchsvoll & Komplex' },
];

function herkunft(e) {
  if (e.quelle === 'mehrheit') {
    return e.stimmen === e.von
      ? `bisher für alle ${e.von} dieser Aufgaben gewählt`
      : `bisher für ${e.stimmen} von ${e.von} dieser Aufgaben gewählt`;
  }
  if (e.quelle === 'geaendert') return 'seit der Umstellung geändert';
  if (e.quelle === 'empfehlung') return 'keine eindeutige Mehrheit, daher vorerst die erste verfügbare Empfehlung für Routine';
  return 'keine eindeutige Mehrheit, daher vorerst ein bisher genutztes Modell';
}

export function AufgabenUmstellungHinweis({ umstellung, mitLink = false, className = '' }) {
  if (!umstellung) return null;
  const zeilen = AUFGABEN.filter((a) => umstellung[a.key]?.model);
  return (
    <div className={`flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 ${className}`}>
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">KI-Modellwahl vereinfacht – bitte Auswahl prüfen</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          In der einfachen Modellwahl gibt es kein Modell je Aufgabe mehr, sondern nur noch zwei
          Aufgabentypen. Die Auswahl wurde aus deinen bisherigen Modellen übernommen und gilt
          vorläufig, bis du sie bestätigst oder änderst:
        </p>
        {zeilen.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {zeilen.map((a) => (
              <li key={a.key} className="text-xs">
                <span className="font-medium">{a.label}:</span>{' '}
                <span className="font-mono">{umstellung[a.key].model}</span>
                <span className="text-muted-foreground"> – {herkunft(umstellung[a.key])}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {mitLink && (
        <Link to="/einstellungen?tab=ki" className="mt-0.5 shrink-0 whitespace-nowrap text-xs text-primary underline underline-offset-2">
          Jetzt wählen →
        </Link>
      )}
    </div>
  );
}
