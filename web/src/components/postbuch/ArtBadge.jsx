import { Badge } from '@/components/ui/badge';
import { ArrowLeft } from 'lucide-react';

// Die Datenbank speichert seit LxD Codes; die UI zeigt weiterhin lesbare Labels
// und behält für jede Dokumentart eine unterscheidbare Farbe.
const DOKUMENTART_LABELS = {
  arztrechnung: 'Arztrechnung', laborrechnung: 'Laborrechnung', rezept: 'Rezept',
  hilfsmittelrechnung: 'Hilfsmittelrechnung', erstattungsbescheid: 'Erstattungsbescheid',
  arztbericht: 'Arztbericht', handwerkerrechnung: 'Handwerkerrechnung', angebot: 'Angebot',
  kaufbeleg: 'Kaufbeleg', bescheid: 'Bescheid', bescheinigung: 'Bescheinigung',
  urkunde_ausweis: 'Urkunde/Ausweis', vertrag: 'Vertrag', mitteilung: 'Mitteilung',
  bericht_befund: 'Bericht/Befund', rechnung: 'Rechnung', korrespondenz: 'Korrespondenz',
  sonstiges: 'Sonstiges',
};

const DOKUMENTART_COLORS = {
  arztrechnung: 'text-violet-700 bg-violet-50 border-violet-200',
  laborrechnung: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  rezept: 'text-cyan-700 bg-cyan-50 border-cyan-200',
  hilfsmittelrechnung: 'text-blue-700 bg-blue-50 border-blue-200',
  erstattungsbescheid: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  arztbericht: 'text-pink-700 bg-pink-50 border-pink-200',
  handwerkerrechnung: 'text-orange-700 bg-orange-50 border-orange-200',
  angebot: 'text-orange-600 bg-orange-50 border-orange-200',
  kaufbeleg: 'text-lime-700 bg-lime-50 border-lime-200',
  bescheid: 'text-slate-700 bg-slate-50 border-slate-200',
  bescheinigung: 'text-sky-700 bg-sky-50 border-sky-200',
  urkunde_ausweis: 'text-stone-700 bg-stone-50 border-stone-200',
  vertrag: 'text-fuchsia-700 bg-fuchsia-50 border-fuchsia-200',
  mitteilung: 'text-teal-700 bg-teal-50 border-teal-200',
  bericht_befund: 'text-rose-700 bg-rose-50 border-rose-200',
  rechnung: 'text-amber-700 bg-amber-50 border-amber-200',
  korrespondenz: 'text-blue-700 bg-blue-50 border-blue-200',
  sonstiges: 'text-gray-600 bg-gray-50 border-gray-200',
};

export function getDokumentartMeta(art) {
  if (!art) return null;
  return {
    label: DOKUMENTART_LABELS[art] || art,
    tone: DOKUMENTART_COLORS[art] || 'text-gray-600 bg-gray-50 border-gray-200',
  };
}

export function ArtBadge({ art, large = false, back = false, truncate = false }) {
  const meta = getDokumentartMeta(art);
  if (!meta) return null;
  return (
    <Badge
      className={`${large ? 'h-8 px-3 text-sm' : 'h-6'} ${truncate ? 'min-w-0 max-w-full' : ''} whitespace-nowrap py-0 leading-none ${meta.tone}`}
      variant="outline"
      title={truncate ? meta.label : undefined}
    >
      {back && <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />}
      <span className={truncate ? 'truncate' : undefined}>{meta.label}</span>
    </Badge>
  );
}
