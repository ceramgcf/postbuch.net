import { useState } from 'react';
import { RotateCcw, RotateCw } from 'lucide-react';
import { useUndoHistory } from '@/hooks/useUndoHistory';

/**
 * UndoRedoBar – sidebar-embedded undo/redo controls.
 * Adapts to expanded/collapsed sidebar modes.
 * Only visible when there is at least one action to undo or redo.
 */
export function UndoRedoBar({ compact = false }) {
  const { past, future, undoLast, redoLast } = useUndoHistory();
  const [loading, setLoading] = useState(false);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  if (!canUndo && !canRedo) return null;

  const handleUndo = async (e) => {
    e.stopPropagation();
    if (loading || !canUndo) return;
    setLoading(true);
    try { await undoLast(); } finally { setLoading(false); }
  };

  const handleRedo = async (e) => {
    e.stopPropagation();
    if (loading || !canRedo) return;
    setLoading(true);
    try { await redoLast(); } finally { setLoading(false); }
  };

  // Label: prefer undo description, fall back to redo
  const label = canUndo
    ? past[past.length - 1].description
    : future[future.length - 1].description;

  if (compact) {
    return (
      <div className="flex flex-col items-center gap-1">
        <button
          onClick={handleUndo}
          disabled={!canUndo || loading}
          title={canUndo ? `Rückgängig: ${past[past.length - 1].description} (Strg+Z)` : 'Nichts rückgängig'}
          className="p-1 rounded hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          onClick={handleRedo}
          disabled={!canRedo || loading}
          title={canRedo ? `Wiederholen: ${future[future.length - 1].description} (Strg+Y)` : 'Nichts wiederholbar'}
          className="p-1 rounded hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground"
        >
          <RotateCw className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-1">
      <button
        onClick={handleUndo}
        disabled={!canUndo || loading}
        title={canUndo ? `Rückgängig: ${past[past.length - 1].description} (Strg+Z)` : 'Nichts rückgängig'}
        className="p-1 rounded hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground"
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
      <span className="text-[11px] text-muted-foreground truncate flex-1 min-w-0 select-none pointer-events-none">
        {label}
      </span>
      <button
        onClick={handleRedo}
        disabled={!canRedo || loading}
        title={canRedo ? `Wiederholen: ${future[future.length - 1].description} (Strg+Y)` : 'Nichts wiederholbar'}
        className="p-1 rounded hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground"
      >
        <RotateCw className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
