import { Check } from 'lucide-react';

// Sonderwerte der Auswahl neben den Kurznamen der Menschen.
export const KEINE = '__keine__';
const NEU = '__neu__';

function rollenText(p) {
  const teile = [];
  if (p.familienmitglied) teile.push(`Adressat/Absender in ${p.familienmitglied} Dok.`);
  if (p.behandelt) teile.push(`behandelte Person in ${p.behandelt} Dok.`);
  return teile.join(' · ');
}

function VorschlagBadge({ person, wert }) {
  const v = person.vorschlag;
  if (!v?.kurzname || wert !== v.kurzname) return null;
  if (v.art === 'exakt') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
        <Check className="h-3 w-3" />exakt
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
      Vorschlag – {v.grund}
    </span>
  );
}

/**
 * Zuordnung der Personennamen einer Dokumentenübergabe zu den Menschen dieser Instanz.
 *
 * @param {object[]} props.personen - aus der Vorprüfung: { name, familienmitglied, behandelt, legende, vorschlag }
 * @param {Record<string, string>} props.zuordnung - Quellname → Kurzname oder KEINE (fehlt = offen)
 * @param {(name: string, wert: string) => void} props.onChange
 * @param {object[]} props.menschen - /api/personen
 * @param {(person: object) => void} props.onNeuAnlegen
 */
export default function PersonenZuordnung({ personen, zuordnung, onChange, menschen, onNeuAnlegen, disabled }) {
  if (!personen.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Das Paket enthält keine Personenbezüge – es ist nichts zuzuordnen.
      </p>
    );
  }

  const nachKurzname = new Map(menschen.map((m) => [m.kurzname, m]));

  return (
    <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
      {personen.map((p) => {
        const wert = zuordnung[p.name] ?? '';
        const offen = wert === '';
        return (
          <li key={p.name} className={`flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4 ${offen ? 'bg-amber-500/[0.04]' : ''}`}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">
                {p.name}
                {p.legende?.anzeigename && p.legende.anzeigename !== p.name && (
                  <span className="font-normal text-muted-foreground"> – {p.legende.anzeigename}</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{rollenText(p)}</p>
            </div>
            <div className="flex flex-col gap-1 sm:w-72">
              <select
                aria-label={`Zuordnung für ${p.name}`}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={wert}
                disabled={disabled}
                onChange={(e) => {
                  if (e.target.value === NEU) onNeuAnlegen(p);
                  else onChange(p.name, e.target.value);
                }}
              >
                <option value="" disabled>Bitte wählen …</option>
                {menschen.map((m) => (
                  <option key={m.kurzname} value={m.kurzname}>
                    {m.kurzname}{m.vollname && m.vollname !== m.kurzname ? ` – ${m.vollname}` : ''}{m.archiviert ? ' (archiviert)' : ''}
                  </option>
                ))}
                {wert && wert !== KEINE && !nachKurzname.has(wert) && <option value={wert}>{wert}</option>}
                <option value={KEINE}>Keine Zuordnung</option>
                <option value={NEU}>+ Neu anlegen …</option>
              </select>
              <div className="flex flex-wrap items-center gap-2">
                <VorschlagBadge person={p} wert={wert} />
                {offen && <span className="text-[11px] text-amber-700 dark:text-amber-400">Kein eindeutiger Treffer – bitte auswählen</span>}
                {wert === KEINE && <span className="text-[11px] text-muted-foreground">Feld bleibt leer</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
