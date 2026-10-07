import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle, ArrowLeft, Ban, ChevronDown, Search, Replace, Sparkles, Undo2, Receipt,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import {
  useErsetzeRechnung, useErsetzungInfo, useErsetzungKandidaten, useHebeErsetzungAuf,
} from '@/hooks/usePostbuch';
import { DisputeAction } from './DisputeField';
import { InvalidateRechnungAction } from './InvalidateRechnungAction';
import { DocumentPicker } from './DocumentPicker';

function zuCent(wert) {
  return Math.round(Number(wert || 0) * 100);
}

// Breite des Menüs (w-80) plus etwas Luft.
const MENUE_BREITE = 336;

/**
 * Das Menü klappt standardmäßig nach links unter dem Knopf auf. Ist der
 * sichtbare Bereich des scrollenden Inhalts links davon zu schmal (breites
 * PDF-Panel), würde es dort abgeschnitten und die Seitenleiste läge über
 * den Einträgen – dann nach rechts aufklappen.
 */
function platzLinksZuKnapp(anker) {
  if (!anker) return false;
  let rahmen = anker.parentElement;
  while (rahmen && rahmen !== document.body) {
    const { overflowX } = getComputedStyle(rahmen);
    if (overflowX !== 'visible') break;
    rahmen = rahmen.parentElement;
  }
  const links = rahmen && rahmen !== document.body ? rahmen.getBoundingClientRect().left : 0;
  return anker.getBoundingClientRect().right - MENUE_BREITE < links;
}

const RICHTUNG_TEXT = {
  vorgaenger: {
    menue: 'Ersetzt eine frühere Rechnung …',
    kopf: 'Welche Rechnung wird hierdurch ersetzt?',
    picker: 'Ursprungsrechnung wählen',
  },
  nachfolger: {
    menue: 'Wird ersetzt durch …',
    kopf: 'Durch welche Rechnung wird diese ersetzt?',
    picker: 'Korrekturrechnung wählen',
  },
};

/**
 * Menü „Rechnung“ im Kopf jeder Rechnungskarte: Bestreiten, Ersetzung durch
 * eine Korrekturrechnung (beide Richtungen) und Invalidieren. Bezahlen und
 * Teilzahlung bleiben am Zahlungsfeld bzw. in der Aktionsleiste.
 *
 * Eine bereits ersetzte Rechnung bietet keine Aktionen mehr an – Zahlungen und
 * Streitfall laufen auf der Nachfolgerin; aufheben lässt sich die Ersetzung im
 * Hinweis über der Karte (ErsetzungHinweis).
 */
export function RechnungMenu({ data, invalidierbar = true }) {
  const { canWrite } = useAuth();
  const [offen, setOffen] = useState(false);
  const [nachRechts, setNachRechts] = useState(false);
  const [ansicht, setAnsicht] = useState('haupt'); // 'haupt' | 'vorgaenger' | 'nachfolger'
  const [dialog, setDialog] = useState(null);     // 'bestreiten' | 'invalidieren' | null
  const [pickerRichtung, setPickerRichtung] = useState(null);
  const [auswahl, setAuswahl] = useState(null);   // { richtung, partner }
  const ref = useRef(null);
  const ersetzung = data?.ersetzung;

  useEffect(() => {
    if (!offen) return undefined;
    function aussen(e) {
      if (ref.current && !ref.current.contains(e.target)) setOffen(false);
    }
    function taste(e) {
      if (e.key === 'Escape') setOffen(false);
    }
    document.addEventListener('mousedown', aussen);
    document.addEventListener('keydown', taste);
    return () => {
      document.removeEventListener('mousedown', aussen);
      document.removeEventListener('keydown', taste);
    };
  }, [offen]);

  if (!canWrite || !data || ersetzung?.ersetzt_durch) return null;

  const bestritten = data.bestritten_betrag != null && Number(data.bestritten_betrag) > 0;

  function umschalten() {
    if (!offen) setNachRechts(platzLinksZuKnapp(ref.current));
    setOffen(v => !v);
    setAnsicht('haupt');
  }
  function oeffneDialog(name) {
    setOffen(false);
    setDialog(name);
  }
  function waehle(richtung, partner) {
    setOffen(false);
    setPickerRichtung(null);
    setAuswahl({ richtung, partner });
  }

  return (
    <>
      <div className="relative" ref={ref}>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={umschalten} aria-haspopup="menu" aria-expanded={offen}>
          <Receipt className="h-3.5 w-3.5" />
          Rechnung
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
        {offen && (
          <div role="menu" className={`absolute ${nachRechts ? 'left-0' : 'right-0'} top-full mt-1 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover shadow-md overflow-hidden`}>
            {ansicht === 'haupt' ? (
              <div className="p-1">
                <MenuEintrag icon={AlertTriangle} onClick={() => oeffneDialog('bestreiten')}>
                  {bestritten ? 'Streitfall bearbeiten …' : 'Rechnung bestreiten …'}
                </MenuEintrag>
                <div className="border-t my-1" />
                {!ersetzung?.ersetzt && (
                  <MenuEintrag icon={Replace} onClick={() => setAnsicht('vorgaenger')}>
                    {RICHTUNG_TEXT.vorgaenger.menue}
                  </MenuEintrag>
                )}
                <MenuEintrag icon={Replace} onClick={() => setAnsicht('nachfolger')}>
                  {RICHTUNG_TEXT.nachfolger.menue}
                </MenuEintrag>
                {invalidierbar && (
                  <>
                    <div className="border-t my-1" />
                    <MenuEintrag icon={Ban} gefaehrlich onClick={() => oeffneDialog('invalidieren')}>
                      Rechnung invalidieren …
                    </MenuEintrag>
                  </>
                )}
              </div>
            ) : (
              <KandidatenAnsicht
                postid={data.postid}
                richtung={ansicht}
                onZurueck={() => setAnsicht('haupt')}
                onWaehle={(partner) => waehle(ansicht, partner)}
                onSuchen={() => { setOffen(false); setPickerRichtung(ansicht); }}
              />
            )}
          </div>
        )}
      </div>

      <DisputeAction
        postid={data.postid}
        gesamtbetrag={data.gesamtbetrag}
        bestritten_betrag={data.bestritten_betrag}
        open={dialog === 'bestreiten'}
        onOpenChange={(v) => setDialog(v ? 'bestreiten' : null)}
      />
      {invalidierbar && (
        <InvalidateRechnungAction
          postid={data.postid}
          open={dialog === 'invalidieren'}
          onOpenChange={(v) => setDialog(v ? 'invalidieren' : null)}
        />
      )}
      <DocumentPicker
        open={!!pickerRichtung}
        onOpenChange={(v) => { if (!v) setPickerRichtung(null); }}
        nurRechnungen
        title={pickerRichtung ? RICHTUNG_TEXT[pickerRichtung].picker : ''}
        description="Suche nach Nummer, Betreff oder Absender – oder füge einen SymLink ein."
        onSelect={(partner) => {
          if (partner === data.postid) return;
          waehle(pickerRichtung, partner);
        }}
      />
      {auswahl && (
        <ErsetzenBestaetigen
          postid={data.postid}
          richtung={auswahl.richtung}
          partner={auswahl.partner}
          onClose={() => setAuswahl(null)}
        />
      )}
    </>
  );
}

function MenuEintrag({ icon: Icon, gefaehrlich = false, onClick, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left hover:bg-accent ${gefaehrlich ? 'text-destructive' : ''}`}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span>{children}</span>
    </button>
  );
}

function KandidatenAnsicht({ postid, richtung, onZurueck, onWaehle, onSuchen }) {
  const { data, isLoading, error } = useErsetzungKandidaten(postid, richtung, true);
  const kandidaten = data || [];
  return (
    <div className="p-1">
      <button type="button" onClick={onZurueck} className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
        <ArrowLeft className="h-3 w-3" />
        {RICHTUNG_TEXT[richtung].kopf}
      </button>
      <div className="flex items-center gap-1 px-2 py-1">
        <Sparkles className="h-2.5 w-2.5 text-violet-500" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-500">Vorschläge</span>
      </div>
      {isLoading && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
          Passende Rechnungen werden gesucht…
        </div>
      )}
      {error && <p className="px-2 py-1.5 text-xs text-destructive">{error.message}</p>}
      {!isLoading && !error && kandidaten.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Keine passende Rechnung gefunden.</p>
      )}
      {kandidaten.map(k => (
        <button
          key={k.postid}
          type="button"
          role="menuitem"
          onClick={() => onWaehle(k.postid)}
          className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
        >
          <span className="flex w-full items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{k.postid}</span>
            <span className="truncate flex-1">{k.aussteller || k.betreff || '–'}</span>
            <span className="flex-shrink-0 tabular-nums text-xs">{k.gesamtbetrag != null ? formatCurrency(k.gesamtbetrag) : ''}</span>
          </span>
          <span className="flex w-full flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            {k.re_nr && <span>Re-Nr. {k.re_nr}</span>}
            {k.rechnungsdatum && <span>{formatDate(k.rechnungsdatum)}</span>}
            {Number(k.bestritten_betrag) > 0 && <span className="text-amber-700">bestritten</span>}
            {k.teilgezahlt && <span className="text-amber-700">teilgezahlt</span>}
            {k.bezahlt_am && !k.teilgezahlt && <span className="text-green-700">bezahlt</span>}
          </span>
        </button>
      ))}
      <div className="border-t my-1" />
      <button type="button" role="menuitem" onClick={onSuchen} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left text-primary hover:bg-accent">
        <Search className="h-3.5 w-3.5" />
        Andere Rechnung suchen …
      </button>
    </div>
  );
}

/**
 * Bestätigung vor dem Ersetzen: nennt Richtung, umziehende Zahlungen, eine
 * mögliche Überzahlung und das Ende eines Streitfalls der alten Rechnung.
 */
function ErsetzenBestaetigen({ postid, richtung, partner, onClose }) {
  const neuId = richtung === 'vorgaenger' ? postid : partner;
  const altId = richtung === 'vorgaenger' ? partner : postid;
  const neu = useErsetzungInfo(neuId);
  const alt = useErsetzungInfo(altId);
  const ersetzen = useErsetzeRechnung();
  const aufheben = useHebeErsetzungAuf();
  const { pushAction } = useUndoHistory();
  const [fehler, setFehler] = useState('');

  const ladeFehler = neu.error || alt.error;
  const n = neu.data?.rechnung;
  const a = alt.data?.rechnung;
  const bereit = !!n && !!a;

  const zahlungenAlt = Number(a?.anzahl_zahlungen || 0);
  const restNeuCent = n ? zuCent(n.gesamtbetrag) - zuCent(n.bestritten_betrag) - zuCent(n.gezahlt) : 0;
  const ueberzahlungCent = a ? zuCent(a.gezahlt) - restNeuCent : 0;
  const body = richtung === 'vorgaenger' ? { vorgaenger: partner } : { nachfolger: partner };

  async function bestaetigen() {
    setFehler('');
    try {
      await ersetzen.mutateAsync({ postid, body });
      pushAction(
        `${neuId} ersetzt ${altId}`,
        () => aufheben.mutateAsync({ postid: altId }),
        () => ersetzen.mutateAsync({ postid, body }),
      );
      onClose();
    } catch (e) {
      setFehler(e.message || 'Die Ersetzung konnte nicht gespeichert werden.');
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} size="lg">
      <DialogTitle className="flex items-center gap-2">
        <Replace className="h-5 w-5 flex-shrink-0" />
        Rechnung ersetzen?
      </DialogTitle>
      <DialogDescription className="mt-2 space-y-2">
        {!bereit && !ladeFehler && <p>Wird geladen…</p>}
        {ladeFehler && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{ladeFehler.message}</p>}
        {bereit && (
          <>
            <p>
              <RechnungKurz r={n} /> <strong>ersetzt</strong> <RechnungKurz r={a} />.
            </p>
            <p>
              Die alte Rechnung gilt danach als erledigt: Sie verschwindet aus „Unbezahlt“, aus der
              Summe offener Beträge und aus den Fälligkeiten. Ihre Daten bleiben unverändert erhalten.
            </p>
            {zahlungenAlt > 0 && (
              <p>
                {zahlungenAlt === 1 ? 'Die erfasste Zahlung' : `Die ${zahlungenAlt} erfassten Zahlungen`} über{' '}
                <strong>{formatCurrency(a.gezahlt)}</strong> {zahlungenAlt === 1 ? 'zieht' : 'ziehen'} auf{' '}
                <span className="font-mono">{n.postid}</span> um.
              </p>
            )}
            {zahlungenAlt > 0 && ueberzahlungCent > 0 && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  Danach ist <span className="font-mono">{n.postid}</span> um{' '}
                  <strong>{formatCurrency(ueberzahlungCent / 100)}</strong> überzahlt. Eine Rückerstattung
                  hältst du am besten in der Notiz fest.
                </span>
              </p>
            )}
            {Number(a.bestritten_betrag) > 0 && (
              <p>
                Der Streitfall von <span className="font-mono">{a.postid}</span> endet mit der Ersetzung.
                Ist auch die Korrekturrechnung strittig, bestreite sie dort neu.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Rückgängig machen kannst du das jederzeit über „Ersetzung aufheben“ an einer der beiden Rechnungen.
            </p>
          </>
        )}
        {fehler && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{fehler}</p>}
      </DialogDescription>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={ersetzen.isPending}>Abbrechen</Button>
        <Button onClick={bestaetigen} disabled={!bereit || ersetzen.isPending}>
          {ersetzen.isPending ? 'Wird gespeichert…' : 'Ersetzen'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function RechnungKurz({ r }) {
  return (
    <span>
      <span className="font-mono">{r.postid}</span>
      {' '}({[r.aussteller, r.re_nr && `Re-Nr. ${r.re_nr}`, r.gesamtbetrag != null && formatCurrency(r.gesamtbetrag)]
        .filter(Boolean).join(', ') || r.betreff || 'Rechnung'})
    </span>
  );
}

/**
 * Hinweis über der Rechnungskarte, wenn die Rechnung eine andere ersetzt oder
 * selbst ersetzt wurde – mit Link zur Partnerrechnung und „Ersetzung aufheben“.
 */
export function ErsetzungHinweis({ postid, ersetzung }) {
  const { canWrite } = useAuth();
  const aufheben = useHebeErsetzungAuf();
  const ersetzen = useErsetzeRechnung();
  const { pushAction } = useUndoHistory();
  const [fehler, setFehler] = useState('');
  if (!ersetzung?.ersetzt && !ersetzung?.ersetzt_durch) return null;

  async function hebeAuf(altId, neuId) {
    setFehler('');
    try {
      await aufheben.mutateAsync({ postid: altId });
      pushAction(
        `Ersetzung von ${altId} aufgehoben`,
        () => ersetzen.mutateAsync({ postid: neuId, body: { vorgaenger: altId } }),
        () => aufheben.mutateAsync({ postid: altId }),
      );
    } catch (e) {
      setFehler(e.message || 'Die Ersetzung konnte nicht aufgehoben werden.');
    }
  }

  const zeile = (text, partner, altId, neuId, ton) => (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm ${ton}`}>
      <Replace className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1 min-w-[12rem]">
        {text}{' '}
        <Link to={`/postbuch/${partner.postid}`} className="font-mono underline underline-offset-2">{partner.postid}</Link>
        {partner.am && <span className="text-muted-foreground"> · seit {formatDate(partner.am)}</span>}
      </span>
      {canWrite && (
        <Button variant="ghost" size="sm" className="h-7 gap-1.5" disabled={aufheben.isPending} onClick={() => hebeAuf(altId, neuId)}>
          <Undo2 className="h-3.5 w-3.5" />
          Ersetzung aufheben
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      {ersetzung.ersetzt_durch && zeile(
        'Diese Rechnung ist erledigt – ersetzt durch die Korrekturrechnung',
        ersetzung.ersetzt_durch, postid, ersetzung.ersetzt_durch.postid,
        'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200',
      )}
      {ersetzung.ersetzt && zeile(
        'Korrekturrechnung – ersetzt die frühere Rechnung',
        ersetzung.ersetzt, ersetzung.ersetzt.postid, postid,
        'border-border bg-muted/40',
      )}
      {fehler && <p className="text-sm text-destructive">{fehler}</p>}
    </div>
  );
}
