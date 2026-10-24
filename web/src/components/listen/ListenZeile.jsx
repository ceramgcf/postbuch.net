import { Link } from 'react-router';

/**
 * Kompakter Listeneintrag der Mobilansicht – das gemeinsame Muster für
 * Listen ohne eigene Karten: oben Titel und Wert, darunter Kennzahlen, bei
 * Bedarf weitere Zeilen (`children`, etwa Begründungen oder Bearbeitung).
 * Einträge stehen in einer <ListenGruppe> und sind nur durch feine Striche
 * getrennt.
 *
 * Mit `to` ein Link, mit `onClick` ein Knopf, sonst reine Anzeige.
 * `umbrechen` lässt den Titel umbrechen statt ihn mit „…“ zu kürzen.
 */
export function ListenZeile({
  to, state, onClick, oben, obenRechts, unten, untenRechts, umbrechen = false, children, className = '',
}) {
  const kopf = (
    <>
      <div className={`flex gap-2 ${umbrechen ? 'items-start' : 'items-center'}`}>
        <div className={`min-w-0 flex-1 text-sm font-medium ${umbrechen ? '' : 'truncate'}`}>{oben}</div>
        {obenRechts && <div className="shrink-0">{obenRechts}</div>}
      </div>
      {(unten || untenRechts) && (
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">{unten}</div>
          {untenRechts && <div className="flex shrink-0 items-center gap-1.5">{untenRechts}</div>}
        </div>
      )}
    </>
  );
  // Ohne Zusatzzeilen ist der ganze Eintrag die Tippfläche.
  const klickbar = 'block w-full text-left active:bg-primary/5';
  const huelle = (cls, inhalt) => (to
    ? <Link to={to} state={state} className={`${klickbar} ${cls}`}>{inhalt}</Link>
    : onClick
      ? <button type="button" onClick={onClick} className={`${klickbar} ${cls}`}>{inhalt}</button>
      : <div className={cls}>{inhalt}</div>);
  if (!children) return huelle(`py-2 ${className}`, kopf);
  return (
    <div className={`py-2 ${className}`}>
      {huelle('', kopf)}
      <div className="mt-1.5 space-y-1.5">{children}</div>
    </div>
  );
}

/** Rahmenlose Liste aus <ListenZeile>-Einträgen mit feinen Trennstrichen. */
export function ListenGruppe({ children, className = '' }) {
  return <div className={`divide-y divide-border/60 ${className}`}>{children}</div>;
}

export const punkt = <span className="text-muted-foreground/40" aria-hidden>·</span>;
