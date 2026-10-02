import { useCallback } from 'react';

/**
 * Zieh-Griff am rechten Rand eines <th> zum Anpassen der Spaltenbreite.
 *
 * Mechanik nach components/layout/PdfPanel.jsx: globale mousemove/mouseup-Listener, während des
 * Drags wird das zugehörige <col>-Element im colgroup DIREKT mutiert (kein Re-Render pro Pixel);
 * committet wird die Breite erst bei mouseup via onCommit → State/localStorage.
 *
 * Setzt voraus, dass die Tabelle ein <colgroup> mit <col data-colkey="…"> nutzt (table-fixed).
 *
 * @param {string}   columnKey
 * @param {number}   min
 * @param {number}   max
 * @param {(px:number)=>void} onCommit  – finale Breite übernehmen
 * @param {()=>void} onReset            – Doppelklick: Standardbreite wiederherstellen
 */
export function ColumnResizer({ columnKey, min = 40, max = 600, onCommit, onReset }) {
  const onMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation(); // nicht als Sortier-Klick auf dem th interpretieren
      const handle = e.currentTarget;
      const th = handle.closest('th');
      const table = handle.closest('table');
      if (!th || !table) return;
      const colEl = table.querySelector(`col[data-colkey="${CSS.escape(columnKey)}"]`);
      const startX = e.clientX;
      const startWidth = th.offsetWidth;
      let newWidth = startWidth;

      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (moveE) => {
        newWidth = Math.max(min, Math.min(max, startWidth + (moveE.clientX - startX)));
        if (colEl) colEl.style.width = `${newWidth}px`;
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        onCommit?.(newWidth);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [columnKey, min, max, onCommit],
  );

  return (
    <span
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset?.();
      }}
      title="Breite ziehen · Doppelklick: Standardbreite"
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize select-none touch-none z-10 hover:bg-primary/40 active:bg-primary/60 transition-colors"
    />
  );
}
