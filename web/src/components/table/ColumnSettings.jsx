import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Columns3, RotateCcw } from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { Dialog, DialogTitle } from '@/components/ui/dialog';

const PANEL_WIDTH = 264;

/**
 * „Spalten"-Konfigurator: Trigger-Icon-Button + leichtgewichtiges Panel zum Ein-/Ausblenden
 * von Spalten und Zurücksetzen (Sichtbarkeit + Breiten).
 *
 * Desktop → Popover (handgerollt nach ArtBadgeEditor-Muster + Portal-Positionierung wie
 * NoteTooltip). Touch → Vollbild-Dialog (ui/dialog.jsx), da ein exakt platziertes Popover
 * dort schlecht bedienbar wäre.
 *
 * @param {Array}  columns   – gemergte Spalten aus useColumnConfig ({ key, label, name?, icon?, visible })
 * @param {number} visibleCount
 * @param {(key:string)=>void} onToggle
 * @param {()=>void} onReset
 */
export function ColumnSettings({ columns, visibleCount, onToggle, onReset }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null);

  // Popover-Position aus Trigger-Rect ableiten (rechtsbündig unter dem Button, im Viewport gehalten).
  useLayoutEffect(() => {
    if (!open || isMobile || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
    setPos({ top: rect.bottom + 6, left });
  }, [open, isMobile]);

  // Klick außerhalb / ESC schließt das Popover.
  useEffect(() => {
    if (!open || isMobile) return;
    function onDocClick(e) {
      if (
        triggerRef.current?.contains(e.target) ||
        panelRef.current?.contains(e.target)
      ) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, isMobile]);

  const list = (
    <ul className="space-y-0.5">
      {columns.map((col) => {
        const label = col.name || col.label || '–';
        const Icon = col.icon || null;
        const lastVisible = col.visible && visibleCount <= 1;
        return (
          <li key={col.key}>
            <label
              className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${
                lastVisible ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/60'
              }`}
              title={lastVisible ? 'Mindestens eine Spalte muss sichtbar bleiben' : undefined}
            >
              <input
                type="checkbox"
                checked={col.visible}
                disabled={lastVisible}
                onChange={() => onToggle(col.key)}
                className="h-4 w-4 accent-primary disabled:cursor-not-allowed"
              />
              {Icon && <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
              <span className="truncate">{label}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );

  const header = (
    <div className="flex items-center justify-between gap-2 mb-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">
        Spalten
      </span>
      <button
        type="button"
        onClick={onReset}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        title="Sichtbarkeit und Breiten zurücksetzen"
      >
        <RotateCcw className="h-3 w-3" />
        Zurücksetzen
      </button>
    </div>
  );

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen((o) => !o)}
      title="Spalten"
      className={`flex-shrink-0 p-1.5 rounded-md transition-colors ${
        open ? 'text-primary bg-primary/10' : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'
      }`}
    >
      <Columns3 className="h-4 w-4" />
    </button>
  );

  return (
    <>
      {trigger}

      {/* Desktop: Popover via Portal */}
      {open && !isMobile && pos && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH, zIndex: 9999 }}
          className="rounded-lg border border-border bg-popover text-popover-foreground shadow-lg p-2 animate-in fade-in"
        >
          {header}
          {list}
        </div>,
        document.body,
      )}

      {/* Mobile: Vollbild-Dialog */}
      {isMobile && (
        <Dialog open={open} onOpenChange={setOpen} size="sm">
          <DialogTitle className="mb-2 flex items-center gap-2">
            <Columns3 className="h-4 w-4 text-primary" />
            Spalten
          </DialogTitle>
          {list}
          <button
            type="button"
            onClick={onReset}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Zurücksetzen
          </button>
        </Dialog>
      )}
    </>
  );
}
