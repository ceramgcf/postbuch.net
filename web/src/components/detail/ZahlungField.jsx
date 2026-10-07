import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Pencil, Check, X, Trash2, Plus } from 'lucide-react';
import { useMarkPaid, useSetZahlungen } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';

function heute() {
  return new Date().toLocaleDateString('sv-SE');
}

function nurDatum(wert) {
  return wert ? String(wert).split('T')[0] : null;
}

/** Nimmt „1.234,56“, „1234,56“ und „1234.56“ an; null bei ungültiger Eingabe. */
function parseBetrag(text) {
  let s = String(text ?? '').trim().replace(/\s|€/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

function zuCent(wert) {
  return Math.round(Number(wert || 0) * 100);
}

/**
 * Offener, nicht bestrittener Restbetrag einer Rechnung für Zahlungskarte und
 * GiroCode. Ohne Zahlungslage (ältere Antwort) gilt die bisherige Regel.
 */
export function offenerRestbetrag(data) {
  // Eine ersetzte Rechnung ist erledigt; offen ist allenfalls die Nachfolgerin.
  if (data?.ersetzung?.ersetzt_durch) return 0;
  if (data?.zahlung && data.zahlung.offen != null) return Number(data.zahlung.offen);
  if (data?.bezahlt_am) return 0;
  return Math.max(0, Number(data?.gesamtbetrag || 0) - Number(data?.bestritten_betrag || 0));
}

/**
 * Zahlstatus einer Rechnung. Intern ist jede Zahlung eine Tranche mit Betrag;
 * eine einzelne Zahlung über den vollen Betrag erscheint als schlichtes
 * „Bezahlt am“. Erst mehrere oder abweichende Zahlungen zeigen die Tabelle.
 */
export function ZahlungField({ postid, bezahlt_am, zahlung, ersetzung }) {
  const [tabelleBearbeiten, setTabelleBearbeiten] = useState(false);
  const teil = zahlung?.anzeige === 'teil';

  // Nach einer Ersetzung laufen Zahlungen nur noch auf der Korrekturrechnung.
  if (ersetzung?.ersetzt_durch) {
    return (
      <div>
        <dt className="text-muted-foreground mb-1">Zahlstatus</dt>
        <dd className="font-medium">
          Erledigt – ersetzt durch <span className="font-mono">{ersetzung.ersetzt_durch.postid}</span>
        </dd>
      </div>
    );
  }

  if (teil || tabelleBearbeiten) {
    return (
      <div className="col-span-full">
        <ZahlungsTabelle
          postid={postid}
          zahlung={zahlung}
          bearbeiten={tabelleBearbeiten}
          setBearbeiten={setTabelleBearbeiten}
        />
      </div>
    );
  }
  return (
    <BezahldatumField
      postid={postid}
      bezahlt_am={bezahlt_am}
      teilzahlungMoeglich={zuCent(zahlung?.zu_zahlen) > 0}
      onTeilzahlung={() => setTabelleBearbeiten(true)}
    />
  );
}

function BezahldatumField({ postid, bezahlt_am, teilzahlungMoeglich, onTeilzahlung }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [fehler, setFehler] = useState(null);
  const { mutate: markPaid, mutateAsync: markPaidAsync, isPending } = useMarkPaid();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();

  function startEdit() {
    setDraft(nurDatum(bezahlt_am) || '');
    setFehler(null);
    setEditing(true);
  }
  function speichere(newDate, label) {
    const oldDate = nurDatum(bezahlt_am);
    setFehler(null);
    markPaid({ postid, date: newDate }, {
      onSuccess: () => {
        setEditing(false);
        pushAction(label, () => markPaidAsync({ postid, date: oldDate }), () => markPaidAsync({ postid, date: newDate }));
      },
      onError: (err) => setFehler(err?.message || 'Das Bezahldatum konnte nicht gespeichert werden.'),
    });
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <dt className="text-muted-foreground">Bezahlt am</dt>
        {!editing && canWrite && (
          <button onClick={startEdit} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors" title="Bezahldatum bearbeiten">
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <Input type="date" value={draft} onChange={e => setDraft(e.target.value)} className="h-7 text-sm w-[160px] max-w-full" />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => speichere(draft || null, 'Bezahldatum geändert')} disabled={isPending} className="h-6 px-2.5 text-xs gap-1">
              <Check className="h-3 w-3" />{isPending ? 'Speichern…' : 'Speichern'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-muted-foreground">
              <X className="h-3 w-3" />Abbrechen
            </Button>
            <Button variant="ghost" size="sm" onClick={() => speichere(null, 'Als offen markiert')} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-destructive/60 hover:text-destructive ml-auto" title="Als offen markieren">
              <Trash2 className="h-3 w-3" />Entfernen
            </Button>
          </div>
          {fehler && <p className="text-xs text-destructive">{fehler}</p>}
        </div>
      ) : (
        <>
          <dd className="font-medium">
            {bezahlt_am
              ? <span className="text-green-600">{formatDate(bezahlt_am)}</span>
              : <span className="text-amber-600">Offen</span>
            }
          </dd>
          {canWrite && teilzahlungMoeglich && (
            <button onClick={onTeilzahlung} className="text-xs text-muted-foreground/70 hover:text-foreground underline-offset-2 hover:underline mt-0.5">
              Teilzahlung erfassen
            </button>
          )}
        </>
      )}
    </div>
  );
}

function entwurfAus(gespeichert) {
  const zeilen = gespeichert.map(z => ({ datum: nurDatum(z.datum), betrag: String(z.betrag).replace('.', ',') }));
  return zeilen.length ? zeilen : [{ datum: heute(), betrag: '' }];
}

function ZahlungsTabelle({ postid, zahlung, bearbeiten, setBearbeiten }) {
  // Aus „Teilzahlung erfassen“ startet die Tabelle direkt im Bearbeiten.
  const [zeilen, setZeilen] = useState(() => (bearbeiten ? entwurfAus(zahlung?.zahlungen || []) : []));
  const [fehler, setFehler] = useState(null);
  const { mutate: setZahlungen, mutateAsync: setZahlungenAsync, isPending } = useSetZahlungen();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();

  const gespeichert = zahlung?.zahlungen || [];
  const zuZahlenCent = zuCent(zahlung?.zu_zahlen);

  function starteBearbeitung() {
    setZeilen(entwurfAus(gespeichert));
    setFehler(null);
    setBearbeiten(true);
  }

  const entwurfCent = zeilen.reduce((summe, z) => summe + zuCent(parseBetrag(z.betrag)), 0);
  const entwurfRest = zuZahlenCent - entwurfCent;

  function aendereZeile(index, feld, wert) {
    setZeilen(alt => alt.map((z, i) => (i === index ? { ...z, [feld]: wert } : z)));
  }
  function neueZeile() {
    const rest = Math.max(entwurfRest, 0);
    setZeilen(alt => [...alt, { datum: heute(), betrag: rest ? (rest / 100).toFixed(2).replace('.', ',') : '' }]);
  }
  function abbrechen() {
    setZeilen([]);
    setFehler(null);
    setBearbeiten(false);
  }
  function speichern() {
    const neu = [];
    for (const z of zeilen) {
      const betrag = parseBetrag(z.betrag);
      if (!z.datum || betrag === null) {
        setFehler('Bitte für jede Zahlung ein Datum und einen Betrag größer 0 angeben.');
        return;
      }
      neu.push({ datum: z.datum, betrag });
    }
    const alt = gespeichert.map(z => ({ datum: nurDatum(z.datum), betrag: z.betrag }));
    setFehler(null);
    setZahlungen({ postid, zahlungen: neu }, {
      onSuccess: () => {
        setZeilen([]);
        setBearbeiten(false);
        pushAction('Zahlungen geändert',
          () => setZahlungenAsync({ postid, zahlungen: alt }),
          () => setZahlungenAsync({ postid, zahlungen: neu }));
      },
      onError: (err) => setFehler(err?.message || 'Die Zahlungen konnten nicht gespeichert werden.'),
    });
  }

  const rest = bearbeiten ? entwurfRest : zuZahlenCent - zuCent(zahlung?.gezahlt);
  const gezahltCent = bearbeiten ? entwurfCent : zuCent(zahlung?.gezahlt);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <dt className="text-muted-foreground">Zahlungen</dt>
        {!bearbeiten && canWrite && (
          <button onClick={starteBearbeitung} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors" title="Zahlungen bearbeiten">
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      <dd>
        <div className="rounded-md border divide-y max-w-md">
          {bearbeiten
            ? zeilen.map((z, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                <Input type="date" value={z.datum || ''} onChange={e => aendereZeile(i, 'datum', e.target.value)} className="h-7 text-sm w-[150px]" aria-label="Zahldatum" />
                <Input inputMode="decimal" value={z.betrag} placeholder="0,00" onChange={e => aendereZeile(i, 'betrag', e.target.value)} className="h-7 text-sm w-[110px] text-right tabular-nums" aria-label="Betrag in Euro" />
                <span className="text-xs text-muted-foreground">€</span>
                <button onClick={() => setZeilen(alt => alt.filter((_, j) => j !== i))} className="ml-auto text-destructive/50 hover:text-destructive" title="Zahlung entfernen">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
            : gespeichert.map(z => (
              <div key={z.zahlung_id} className="flex items-center justify-between gap-4 px-2.5 py-1.5">
                <span>{formatDate(z.datum)}</span>
                <span className="font-medium tabular-nums">{formatCurrency(z.betrag)}</span>
              </div>
            ))}
          {bearbeiten && zeilen.length === 0 && (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">Keine Zahlungen – die Rechnung gilt nach dem Speichern als offen.</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-2.5 py-1.5 bg-muted/40 text-xs">
            <span className="text-muted-foreground">Gezahlt {formatCurrency(gezahltCent / 100)}</span>
            {rest > 0 && <span className="font-medium text-amber-600">Noch offen {formatCurrency(rest / 100)}</span>}
            {rest === 0 && <span className="font-medium text-green-600">Ausgeglichen</span>}
            {rest < 0 && <span className="font-medium text-amber-700">Überzahlt um {formatCurrency(-rest / 100)}</span>}
          </div>
        </div>
        {bearbeiten && (
          <div className="mt-1.5 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={neueZeile} disabled={isPending} className="h-6 px-2 text-xs gap-1">
                <Plus className="h-3 w-3" />Zahlung hinzufügen
              </Button>
              <Button size="sm" onClick={speichern} disabled={isPending} className="h-6 px-2.5 text-xs gap-1">
                <Check className="h-3 w-3" />{isPending ? 'Speichern…' : 'Speichern'}
              </Button>
              <Button variant="ghost" size="sm" onClick={abbrechen} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-muted-foreground">
                <X className="h-3 w-3" />Abbrechen
              </Button>
            </div>
            {fehler && <p className="text-xs text-destructive">{fehler}</p>}
          </div>
        )}
      </dd>
    </div>
  );
}
