/**
 * SetupGuide – die aufklappbare „So richtest du das ein"-Anleitung.
 *
 * Aus SettingsPage.jsx herausgelöst, weil sie inzwischen an mehreren Stellen
 * gebraucht wird (OneDrive, Discord) und der Einrichtungsassistent dieselben
 * Karten inline rendert.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function SetupGuideCard({ icon: Icon, title, subtitle, tone = 'sky', children, defaultOpen = true }) {
  const tones = {
    sky: 'border-sky-200/80 bg-gradient-to-br from-sky-50 via-white to-cyan-50 text-slate-800',
    rose: 'border-rose-200/80 bg-gradient-to-br from-rose-50 via-white to-pink-50 text-slate-800',
    amber: 'border-amber-200/80 bg-gradient-to-br from-amber-50 via-white to-orange-50 text-slate-800',
  };

  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${tones[tone] || tones.sky}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-white/80 p-2 shadow-sm ring-1 ring-black/5">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold tracking-tight">{title}</p>
              {subtitle && <p className="text-xs leading-5 text-slate-600">{subtitle}</p>}
            </div>
            <button type="button" onClick={() => setOpen(!open)} className="ml-4 shrink-0 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <span className="font-medium">{open ? 'Anleitung einklappen' : 'Anleitung anzeigen'}</span>
            </button>
          </div>
        </div>
      </div>
      {open && <div className="mt-4 space-y-3">{children}</div>}
    </div>
  );
}
export function SetupStepList({ steps }) {
  return (
    <ol className="space-y-2.5">
      {steps.map((step, index) => (
        <li key={index} className="flex items-start gap-3">
          <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-semibold shadow-sm ring-1 ring-black/5">
            {index + 1}
          </span>
          <div className="min-w-0 text-xs leading-5 text-slate-700">{step}</div>
        </li>
      ))}
    </ol>
  );
}
