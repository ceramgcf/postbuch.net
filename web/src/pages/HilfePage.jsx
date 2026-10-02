import { cloneElement, isValidElement, useEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, ChevronLeft, ExternalLink, FileQuestion, Camera, AlertTriangle, OctagonAlert, Info, Lightbulb, MessageSquareWarning } from 'lucide-react';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import {
  DOCS_INDEX, KAPITEL_RE, ankerZaehler, bildQuelle, deuteLink,
  inhaltsverzeichnis, kapitelRoute,
} from '@/lib/docs';

/**
 * HilfePage – die Anwenderdokumentation aus `docs/` innerhalb der App.
 *
 * Die Kapitel werden vom eigenen Webserver ausgeliefert (`/docs/*.md`, vom
 * Web-Image mitgebracht). Es wird nichts nachgeladen, was nicht aus der
 * eigenen Instanz kommt – die Hilfe funktioniert also ohne Internetzugang.
 * Gerendert wird die Markdown-Quelle unverändert; angepasst werden nur die
 * Verweise, weil `.md`-Links im Repo auf Dateien zeigen und hier auf Routen.
 */

async function ladeKapitel(datei) {
  const res = await fetch(`/docs/${datei}.md`, { headers: { Accept: 'text/plain' } });
  if (!res.ok) {
    const fehler = new Error(`Kapitel nicht ladbar (HTTP ${res.status})`);
    fehler.status = res.status;
    throw fehler;
  }
  return res.text();
}

/** Reiner Text eines React-Teilbaums – Grundlage für die Überschriften-Anker. */
function knotenText(children) {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(knotenText).join('');
  if (children.props) return knotenText(children.props.children);
  return '';
}

/**
 * GitHub-Alerts (`> [!WARNING]` …) sind in den Kapiteln die Form für Hinweise,
 * die man nicht überlesen soll. Ohne Sonderbehandlung landet die Markierung als
 * sichtbarer Text `[!WARNING]` im Zitatblock – die stärkste Warnung der Doku
 * sähe dann aus wie ein Tippfehler. Deshalb hier: Typ erkennen, Markierung aus
 * dem Text entfernen, farbigen Block daraus machen.
 */
const ALERT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/;

const ALERT_STILE = {
  NOTE:      { label: 'Hinweis',   icon: Info,                  rahmen: 'border-sky-500/40 bg-sky-500/[0.06]',    farbe: 'text-sky-600 dark:text-sky-400' },
  TIP:       { label: 'Tipp',      icon: Lightbulb,             rahmen: 'border-emerald-500/40 bg-emerald-500/[0.06]', farbe: 'text-emerald-600 dark:text-emerald-400' },
  IMPORTANT: { label: 'Wichtig',   icon: MessageSquareWarning,  rahmen: 'border-violet-500/40 bg-violet-500/[0.06]',   farbe: 'text-violet-600 dark:text-violet-400' },
  WARNING:   { label: 'Warnung',   icon: AlertTriangle,         rahmen: 'border-amber-500/50 bg-amber-500/[0.08]',     farbe: 'text-amber-600 dark:text-amber-500' },
  CAUTION:   { label: 'Vorsicht',  icon: OctagonAlert,          rahmen: 'border-destructive/50 bg-destructive/[0.07]', farbe: 'text-destructive' },
};

/**
 * Entfernt die Alert-Markierung aus dem ersten Textknoten des Baums. Sie steht
 * je nach Schreibweise allein in einem Absatz oder direkt vor dem Fließtext –
 * beides muss verschwinden, ein leer gewordener Absatz gleich mit.
 */
function ohneAlertMarker(children) {
  const liste = Array.isArray(children) ? [...children] : [children];
  for (let i = 0; i < liste.length; i++) {
    const kind = liste[i];
    if (kind == null || typeof kind === 'boolean') continue;
    if (typeof kind === 'string' || typeof kind === 'number') {
      const roh = String(kind);
      // Zwischen den Blöcken stehen reine Umbruch-Strings – die sind nicht der
      // gesuchte erste Textknoten, sonst bräche die Suche hier bereits ab.
      if (roh.trim() === '') continue;
      const rest = roh.replace(ALERT_RE, '');
      if (rest === roh) return liste;            // Markierung schon weg
      if (rest.trim() === '') { liste.splice(i, 1); return liste; }
      liste[i] = rest;
      return liste;
    }
    if (isValidElement(kind)) {
      if (knotenText(kind).trim() === '') continue;
      const innen = ohneAlertMarker(kind.props.children);
      if (knotenText(innen).trim() === '') liste.splice(i, 1);
      else liste[i] = cloneElement(kind, { children: innen });
      return liste;
    }
  }
  return liste;
}

function scrolleZuAnker(anker) {
  if (!anker) return;
  const ziel = document.getElementById(anker);
  if (ziel) ziel.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function makeComponents({ pathname, navigate, anker }) {
  const ueberschrift = (Tag, klasse) => ({ children }) => {
    const id = anker(knotenText(children));
    return <Tag id={id} className={`scroll-mt-6 ${klasse}`}>{children}</Tag>;
  };

  return {
    h1: ueberschrift('h1', 'text-2xl font-bold text-foreground mt-0 mb-5'),
    h2: ueberschrift('h2', 'text-lg font-semibold text-foreground mt-9 mb-3 pb-1.5 border-b border-border/60'),
    h3: ueberschrift('h3', 'text-[15px] font-semibold text-foreground mt-6 mb-2'),
    h4: ueberschrift('h4', 'text-sm font-semibold text-foreground mt-4 mb-1.5'),

    p: ({ children }) => <p className="mb-3 text-sm leading-7 text-foreground/90">{children}</p>,
    ul: ({ children }) => <ul className="list-disc mb-4 space-y-1.5 pl-5 text-sm leading-7 text-foreground/90 marker:text-primary/50">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal mb-4 space-y-1.5 pl-5 text-sm leading-7 text-foreground/90 marker:text-primary/60">{children}</ol>,
    li: ({ children }) => <li className="pl-1">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through opacity-60">{children}</del>,

    // `inline` wird von react-markdown 9 nicht mehr durchgereicht. Deshalb wird
    // jedes <code> wie Fließtext-Code gestaltet und die Auszeichnung innerhalb
    // eines Blocks vom <pre> wieder zurückgenommen – das funktioniert ohne
    // Versionsannahme.
    code: ({ children }) => (
      <code className="bg-primary/8 text-primary/90 rounded px-1.5 py-0.5 text-[12.5px] font-mono">{children}</code>
    ),
    pre: ({ children }) => (
      <pre className="bg-muted/60 border border-border/60 rounded-lg p-3 my-4 text-xs font-mono overflow-x-auto leading-6
                      [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground/90 [&_code]:text-xs">
        {children}
      </pre>
    ),

    // Die Kapitel benutzen Zitatblöcke für Hinweise und für die noch offenen
    // Screenshot-Platzhalter. Letztere bekommen einen erkennbar vorläufigen
    // Rahmen, damit niemand sie für Inhalt hält.
    blockquote: ({ children }) => {
      const text = knotenText(children);
      const alert = ALERT_RE.exec(text);
      if (alert) {
        const { label, icon: Icon, rahmen, farbe } = ALERT_STILE[alert[1]];
        return (
          <div className={`my-4 rounded-lg border-2 px-4 py-3 ${rahmen}`}>
            <div className={`flex items-center gap-2 mb-1.5 text-xs font-semibold uppercase tracking-wider ${farbe}`}>
              <Icon className="h-4 w-4 flex-shrink-0" />{label}
            </div>
            <div className="text-sm leading-6 text-foreground/90 [&>*:last-child]:mb-0">
              {ohneAlertMarker(children)}
            </div>
          </div>
        );
      }
      const istPlatzhalter = text.includes('Screenshot-Platzhalter');
      if (istPlatzhalter) {
        return (
          <div className="my-4 rounded-lg border border-dashed border-primary/30 bg-primary/[0.03] px-4 py-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2 mb-1 font-medium text-primary/70">
              <Camera className="h-3.5 w-3.5" /> Bild folgt
            </div>
            {children}
          </div>
        );
      }
      return (
        <blockquote className="border-l-2 border-primary/40 bg-primary/[0.03] rounded-r-lg pl-4 pr-3 py-2 my-4 text-sm text-foreground/80">
          {children}
        </blockquote>
      );
    },

    a: ({ href, children }) => {
      const ziel = deuteLink(href);
      const stil = 'text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary';

      if (ziel.typ === 'extern') {
        return (
          <a href={ziel.ziel} target="_blank" rel="noopener noreferrer" className={`${stil} inline-flex items-baseline gap-0.5`}>
            {children}<ExternalLink className="h-3 w-3 self-center opacity-60" />
          </a>
        );
      }
      if (ziel.typ === 'anker') {
        return (
          <a
            href={`#${ziel.anker}`}
            className={stil}
            onClick={(e) => {
              e.preventDefault();
              navigate(`${pathname}#${ziel.anker}`);
              scrolleZuAnker(ziel.anker);
            }}
          >
            {children}
          </a>
        );
      }
      if (ziel.typ === 'kapitel') {
        return <Link to={kapitelRoute(ziel.name, ziel.anker)} className={stil}>{children}</Link>;
      }
      // Verweise ohne Ziel in der App (etwa das Projekt-README im Repo-Wurzel-
      // verzeichnis) werden als Text gezeigt statt als Link ins Leere.
      return <span className="text-foreground/70" title="Dieser Verweis führt aus der App heraus">{children}</span>;
    },

    img: ({ src, alt }) => {
      const istDokumentationsIcon = typeof src === 'string' && src.startsWith('icons/');
      return (
        <img src={bildQuelle(src)} alt={alt || ''} loading="lazy"
          className={istDokumentationsIcon
            ? 'inline-block h-4 w-4 mx-1 align-[-0.2em]'
            : 'my-4 rounded-lg border border-border/60 max-w-full'} />
      );
    },

    table: ({ children }) => (
      <div className="overflow-x-auto my-4 rounded-lg border border-border/60">
        <table className="text-[13px] border-collapse w-full">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
    th: ({ children }) => <th className="border-b border-border/60 px-3 py-2 font-semibold text-left align-top">{children}</th>,
    td: ({ children }) => <td className="border-b border-border/40 px-3 py-2 align-top leading-6">{children}</td>,
    hr: () => <hr className="my-8 border-border/60" />,
  };
}

export default function HilfePage() {
  const { kapitel } = useParams();
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const artikelRef = useRef(null);

  const name = kapitel || DOCS_INDEX;
  const gueltig = !kapitel || KAPITEL_RE.test(kapitel);

  const { data, isLoading, error } = useQuery({
    queryKey: ['docs-kapitel', name],
    queryFn: () => ladeKapitel(name),
    enabled: gueltig,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const gliederung = useMemo(() => (data ? inhaltsverzeichnis(data) : []), [data]);

  // Neues Kapitel → an den Anfang; Kapitel mit Anker → zur Überschrift. Beides
  // erst, wenn der Markdown-Baum steht, sonst gibt es das Ziel noch nicht.
  useEffect(() => {
    if (!data) return;
    const anker = hash ? decodeURIComponent(hash.slice(1)) : '';
    if (anker) {
      // Ein Frame warten: React hat das Markdown gerade erst eingehängt.
      const id = requestAnimationFrame(() => scrolleZuAnker(anker));
      return () => cancelAnimationFrame(id);
    }
    artikelRef.current?.closest('main')?.scrollTo({ top: 0 });
  }, [data, hash]);

  // Bewusst NICHT memoisiert: der Ankerzähler muss bei jedem Renderdurchlauf
  // von vorn beginnen. Ein gemerkter Zähler würde bei jedem Re-Render weiter
  // hochzählen und die IDs der Überschriften unter den Links wegziehen.
  const components = makeComponents({ pathname, navigate, anker: ankerZaehler() });

  if (!gueltig || error) {
    return (
      <div className="p-6">
        <EmptyState
          icon={FileQuestion}
          title="Kapitel nicht gefunden"
          description="Dieses Hilfe-Kapitel gibt es nicht (mehr)."
        >
          <Link to="/hilfe" className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline underline-offset-2">
            <BookOpen className="h-4 w-4" /> Zur Kapitelübersicht
          </Link>
        </EmptyState>
      </div>
    );
  }

  if (isLoading) return <PageLoader />;

  return (
    <div className="p-6">
      <div className="flex items-start gap-10 mx-auto max-w-[1180px]">
        <article ref={artikelRef} className="min-w-0 flex-1 max-w-3xl">
          <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
            {kapitel ? (
              <Link to="/hilfe" className="inline-flex items-center gap-1 hover:text-primary transition-colors">
                <ChevronLeft className="h-3.5 w-3.5" /> Kapitelübersicht
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5" /> Hilfe · Version {__APP_VERSION__}
              </span>
            )}
          </div>

          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {data}
          </ReactMarkdown>
        </article>

        {gliederung.length >= 3 && (
          <nav className="hidden xl:block w-56 flex-shrink-0 sticky top-6 self-start">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
              Auf dieser Seite
            </p>
            <ul className="space-y-1.5 border-l border-border/60 pl-3">
              {gliederung.map(({ text, id }) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="block text-xs leading-5 text-muted-foreground hover:text-primary transition-colors"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`${pathname}#${id}`);
                      scrolleZuAnker(id);
                    }}
                  >
                    {text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </div>
  );
}
