/**
 * ManuellAblegenFormular.jsx – Basisablage eines Eingangs ohne KI.
 *
 * Pflicht sind Lebensbereich und Dokumentart aus der aktiven Taxonomie; alles
 * Weitere ist freiwillig. Die Werte hält die aufrufende Seite, damit sie einen
 * Konflikt und die Dauer des Laufs überstehen.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

const FACHHINWEISE = {
  arztrechnung: 'Rechnungsdaten, Einzelpositionen und Belegzeilen kannst du nach dem Ablegen in der Dokumentansicht erfassen.',
  erstattungsbescheid: 'Erstattungsbetrag und Positionen des Bescheids entstehen erst durch eine KI-Auswertung.',
};

export function leeresFormular() {
  return {
    lebensbereich: '',
    dokumentart: '',
    briefdatum: '',
    name: '',
    istRechnung: false,
  };
}

function Feld({ label, hinweis, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hinweis && <span className="block text-xs text-muted-foreground">{hinweis}</span>}
    </label>
  );
}

export default function ManuellAblegenFormular({ wert, onChange, onAbsenden, onAbbrechen, gesperrt, fehler }) {
  const { data: tax, error: taxFehler } = useQuery({
    queryKey: ['taxonomie'],
    queryFn: () => api.taxonomie.get(),
    staleTime: 5 * 60 * 1000,
  });

  const lebensbereiche = (tax?.lebensbereich ?? []).filter((l) => l.aktiv);
  const dokumentarten = (tax?.dokumentart ?? []).filter((d) => d.aktiv);
  const dokumentart = dokumentarten.find((d) => d.code === wert.dokumentart);
  // Eine Spezialpipeline greift nur für freigeschaltete Paare; dort steht fest,
  // ob das Dokument eine Rechnung ist.
  const spezial = !!dokumentart?.spezial_pipeline && (tax?.sdAktivierung ?? []).some((a) =>
    a.lebensbereich_code === wert.lebensbereich && a.dokumentart_code === wert.dokumentart);
  const setze = (feld) => (ev) => onChange({
    ...wert,
    [feld]: ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value,
  });
  const vollstaendig = !!wert.lebensbereich && !!wert.dokumentart && !!wert.name.trim();
  const fachhinweis = spezial
    ? FACHHINWEISE[dokumentart.spezial_pipeline] ?? 'Die Fachdaten kannst du nach dem Ablegen in der Dokumentansicht ergänzen.'
    : null;

  return (
    <form
      className="space-y-4"
      onSubmit={(ev) => { ev.preventDefault(); if (vollstaendig && !gesperrt) onAbsenden(); }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Feld label="Lebensbereich">
          <Select value={wert.lebensbereich} onChange={setze('lebensbereich')} disabled={gesperrt} required>
            <option value="">Bitte wählen …</option>
            {lebensbereiche.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </Feld>
        <Feld label="Dokumentart">
          <Select value={wert.dokumentart} onChange={setze('dokumentart')} disabled={gesperrt} required>
            <option value="">Bitte wählen …</option>
            {dokumentarten.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
          </Select>
        </Feld>
      </div>

      <Feld label="Dokumentdatum (optional)" hinweis="Ohne Angabe bleibt das Dokument undatiert.">
        <Input type="date" value={wert.briefdatum} onChange={setze('briefdatum')} disabled={gesperrt} className="sm:max-w-[14rem]" />
      </Feld>

      <Feld
        label="Name/Betreff"
        hinweis="Wird Betreff des Dokuments und Dateiname: „Name Kennung.pdf“. Im Dateinamen werden unzulässige Zeichen entfernt, ein sehr langer Name wird abgeschnitten."
      >
        <Input
          value={wert.name} onChange={setze('name')} disabled={gesperrt} maxLength={300} required
          placeholder="z. B. Stromabrechnung 2026"
        />
      </Feld>

      {!spezial && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox" checked={wert.istRechnung} onChange={setze('istRechnung')} disabled={gesperrt}
            className="h-4 w-4 rounded border-input accent-primary"
          />
          Ist eine Rechnung
        </label>
      )}

      <ul className="list-disc space-y-1 rounded-lg border border-amber-300 bg-amber-50 py-2.5 pl-8 pr-3 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
        <li>Das Dokument wird ohne automatische Duplikatprüfung abgelegt.</li>
        <li>Kontakt, Zusammenfassung und Schlagwörter kannst du später in der Dokumentansicht ergänzen.</li>
        {fachhinweis && <li>{fachhinweis}</li>}
      </ul>

      {(fehler || taxFehler) && (
        <p className="text-sm text-red-600 dark:text-red-400">{fehler || `Die Auswahlwerte konnten nicht geladen werden: ${taxFehler.message}`}</p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onAbbrechen} disabled={gesperrt}>Abbrechen</Button>
        <Button type="submit" disabled={!vollstaendig || gesperrt}>
          {gesperrt ? 'Wird abgelegt …' : 'Ohne KI ablegen'}
        </Button>
      </div>
    </form>
  );
}
