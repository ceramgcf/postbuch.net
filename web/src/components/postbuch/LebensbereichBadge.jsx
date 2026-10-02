import {
  ArrowLeft, BriefcaseBusiness, Car, Coffee, Euro, Folder, GraduationCap, HeartPulse, House,
  Landmark, PawPrint, ShieldCheck, Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const LEBENSBEREICHE = {
  tier: { label: 'Tier', Icon: PawPrint, tone: 'text-amber-800 bg-amber-100 border-amber-300' },
  steuer_behoerden: { label: 'Steuer & Behörden', Icon: Landmark, tone: 'text-slate-700 bg-slate-100 border-slate-300' },
  vorsorge: { label: 'Vorsorge & Absicherung', Icon: ShieldCheck, tone: 'text-purple-700 bg-purple-50 border-purple-200' },
  gesundheit: { label: 'Gesundheit', Icon: HeartPulse, tone: 'text-rose-700 bg-rose-50 border-rose-200' },
  beruf: { label: 'Beruf', Icon: BriefcaseBusiness, tone: 'text-sky-700 bg-sky-50 border-sky-200' },
  bildung: { label: 'Bildung', Icon: GraduationCap, tone: 'text-indigo-700 bg-indigo-50 border-indigo-200' },
  mobilitaet: { label: 'Mobilität', Icon: Car, tone: 'text-orange-700 bg-orange-50 border-orange-200' },
  versorgung: { label: 'Versorgung', Icon: Zap, tone: 'text-yellow-800 bg-yellow-50 border-yellow-200' },
  wohnen: { label: 'Wohnen', Icon: House, tone: 'text-stone-700 bg-stone-50 border-stone-200' },
  finanzen: { label: 'Finanzen', Icon: Euro, tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  freizeit: { label: 'Freizeit', Icon: Coffee, tone: 'text-green-700 bg-green-50 border-green-200' },
  allgemeines: { label: 'Allgemeines', Icon: Folder, tone: 'text-gray-700 bg-gray-50 border-gray-200' },
};

/** LxD-Lebensbereich: in Listen kompakt, in der Detailansicht lesbar. */
export function getLebensbereichMeta(lebensbereich) {
  if (!lebensbereich) return null;
  return LEBENSBEREICHE[lebensbereich] || {
    label: lebensbereich.replace(/_/g, ' '), Icon: Folder,
    tone: 'text-gray-700 bg-gray-50 border-gray-200',
  };
}

export function LebensbereichBadge({ lebensbereich, compact = false, large = false, back = false }) {
  if (!lebensbereich) return null;
  const meta = getLebensbereichMeta(lebensbereich);
  const { Icon } = meta;
  if (compact) {
    return (
      <span
        title={`Lebensbereich: ${meta.label}`}
        aria-label={`Lebensbereich: ${meta.label}`}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${meta.tone}`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <Badge variant="outline" className={`${large ? 'h-8 gap-2 px-3 text-sm' : 'h-6 gap-1.5'} whitespace-nowrap py-0 leading-none ${meta.tone}`}>
      {back && <ArrowLeft className="h-4 w-4" aria-hidden="true" />}
      <Icon className={large ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}
