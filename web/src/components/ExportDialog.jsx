/**
 * ExportDialog – Mehrstufiger Export-Dialog für Dokumenten-Listen.
 *
 * Props:
 *   open            boolean
 *   onClose         () => void
 *   phase           'scope' | 'format'
 *   pageCount       number
 *   totalCount      number
 *   selectionCount  number
 *   exportCount     number   Tatsächlich zu exportierende Dokumente (für Merge-Sperre)
 *   allowPageScope  boolean
 *   isAkte          boolean
 *   onScopeChosen   (scope: 'page'|'selection'|'all') => void
 *   onExport        (format: string) => Promise<void>
 *   isExporting     boolean
 *   exportProgress  null | { step: number, total: number, format: string }
 */

import { FileText, Archive, Sheet, ChevronRight, Loader2, FileDown, PackageOpen } from 'lucide-react';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const MAX_MERGE = 50;

const FORMATS = [
  {
    id:    'pdf-merged',
    label: 'Zusammengeführte PDF',
    desc:  'Alle Dokumente in einer PDF-Datei, mit Deckblatt',
    Icon:  FileText,
  },
  {
    id:    'zip',
    label: 'ZIP-Archiv',
    desc:  'Einzelne PDFs + Deckblatt in einem Windows-kompatiblen ZIP',
    Icon:  Archive,
  },
  {
    id:    'excel',
    label: 'Excel-Tabelle',
    desc:  'Spalten der aktuellen Ansicht + OneDrive-Link',
    Icon:  Sheet,
  },
  {
    id:    'zip-archiv',
    label: 'Dokumentenübergabe (ZIP)',
    desc:  'Dokumente mit Fachdaten übertragen – ohne Abrechnungskontext, ohne KI',
    Icon:  PackageOpen,
  },
];

export function ExportDialog({
  open,
  onClose,
  phase          = 'scope',
  pageCount      = 0,
  totalCount     = 0,
  selectionCount = 0,
  exportCount    = 0,
  allowPageScope = true,
  isAkte         = false,
  onScopeChosen,
  onExport,
  isExporting    = false,
  exportProgress = null,
}) {
  const activeFormat = FORMATS.find(f => f.id === exportProgress?.format);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !isExporting) onClose(); }} size="lg">
      {phase === 'scope' && (
        <>
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="h-5 w-5 text-primary" />
            Export – Auswahl
          </DialogTitle>
          <DialogDescription className="mt-1">
            Welche Dokumente sollen exportiert werden?
            {isAkte && <span className="block mt-0.5 text-xs">Das Deckblatt enthält die Akten-Metadaten.</span>}
          </DialogDescription>

          <div className="mt-5 space-y-2">
            {allowPageScope && (
              <ScopeButton
                label="Sichtbare Seite"
                count={pageCount}
                onClick={() => onScopeChosen?.('page')}
              />
            )}
            <ScopeButton
              label={allowPageScope ? 'Alle Dokumente' : 'Alle Dokumente in Akte'}
              count={totalCount}
              highlight
              onClick={() => onScopeChosen?.('all')}
            />
            <ScopeButton
              label="Auswahl treffen"
              count={null}
              desc="Checkboxen erscheinen in der Tabelle"
              onClick={() => onScopeChosen?.('selection')}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          </DialogFooter>
        </>
      )}

      {phase === 'format' && (
        <>
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="h-5 w-5 text-primary" />
            Export – Format wählen
          </DialogTitle>
          <DialogDescription className="mt-1">
            {selectionCount > 0
              ? `${selectionCount} Dokument${selectionCount !== 1 ? 'e' : ''} ausgewählt`
              : `${totalCount} Dokument${totalCount !== 1 ? 'e' : ''}`}
            {isAkte && ' · Akten-Deckblatt wird beigefügt'}
          </DialogDescription>

          {/* Fortschrittsansicht */}
          {exportProgress ? (
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-3">
                {activeFormat && <activeFormat.Icon className="h-5 w-5 text-primary flex-shrink-0" />}
                <p className="text-sm font-medium">
                  {exportProgress.step < exportProgress.total
                    ? `${activeFormat?.label ?? 'Export'} wird vorbereitet…`
                    : `${activeFormat?.label ?? 'Export'} wird heruntergeladen…`}
                </p>
              </div>
              <ProgressBar step={exportProgress.step} total={exportProgress.total} />
              <p className="text-xs text-muted-foreground text-right">
                {exportProgress.step} von {exportProgress.total} Dokument{exportProgress.total !== 1 ? 'en' : ''} geladen
              </p>
            </div>
          ) : (
            /* Formatauswahl */
            <div className="mt-5 space-y-2">
              {FORMATS.map(({ id, label, desc, Icon }) => {
                const mergeDisabled = id === 'pdf-merged' && exportCount > MAX_MERGE;
                const disabled = isExporting || mergeDisabled;
                return (
                  <div key={id}>
                    <button
                      disabled={disabled}
                      onClick={() => !disabled && onExport?.(id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-all text-left group
                        ${mergeDisabled
                          ? 'border-border/40 bg-muted/40 opacity-60 cursor-not-allowed'
                          : 'border-border/60 bg-background hover:bg-accent/60 hover:border-primary/40 disabled:opacity-50 disabled:cursor-not-allowed'
                        }`}
                    >
                      <Icon className={`h-5 w-5 flex-shrink-0 ${mergeDisabled ? 'text-muted-foreground' : 'text-primary group-hover:scale-110 transition-transform'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                      </div>
                      {isExporting
                        ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        : <ChevronRight className={`h-4 w-4 transition-colors ${mergeDisabled ? 'text-muted-foreground/50' : 'text-muted-foreground group-hover:text-foreground'}`} />
                      }
                    </button>
                    {mergeDisabled && (
                      <p className="text-xs text-amber-600 dark:text-amber-500 mt-1 px-1">
                        Zusammenführen ist auf {MAX_MERGE} Dokumente begrenzt ({exportCount} gewählt) – bitte ZIP verwenden.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={isExporting}>
              Abbrechen
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

function ProgressBar({ step, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;
  return (
    <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
      <div
        className="progress-gradient h-3 rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ScopeButton({ label, count, desc, highlight, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-all text-left group
        ${highlight
          ? 'border-primary/40 bg-primary/5 hover:bg-primary/10 hover:border-primary/60'
          : 'border-border/60 bg-background hover:bg-accent/60 hover:border-primary/30'
        }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {desc && <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>}
      </div>
      {count != null && (
        <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
          {count}
        </span>
      )}
      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
    </button>
  );
}
