import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const UndoHistoryContext = createContext(null);

const MAX_HISTORY = 10;

/**
 * UndoHistoryProvider – session-only, in-memory undo/redo stack.
 *
 * Rules:
 *  • Max 10 entries. Oldest are dropped when limit is reached.
 *  • Only DB-write actions are tracked. n8n-webhook actions must call
 *    clearHistory() before executing.
 *  • Not persistent – clears on page reload.
 */
export function UndoHistoryProvider({ children }) {
  // past: [{id, description, undo, redo?}]  – head = oldest, tail = latest
  const [past, setPast] = useState([]);
  // future: [{id, description, undo, redo}]  – tail = most recently undone
  const [future, setFuture] = useState([]);

  /** Register a new undoable action. Clears the redo stack. */
  const pushAction = useCallback((description, undoFn, redoFn = null) => {
    const entry = { id: Date.now() + Math.random(), description, undo: undoFn, redo: redoFn };
    setPast(prev => [...prev.slice(-(MAX_HISTORY - 1)), entry]);
    setFuture([]);
  }, []);

  /** Clear entire history (call before n8n-webhook actions). */
  const clearHistory = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  /** Execute undo for the most recent action. */
  const undoLast = useCallback(async () => {
    if (past.length === 0) return;
    const last = past[past.length - 1];
    try {
      await last.undo();
      setPast(prev => prev.slice(0, -1));
      if (last.redo) {
        setFuture(prev => [...prev, last]);
      }
    } catch (err) {
      console.error('[UndoHistory] Undo failed:', err);
    }
  }, [past]);

  /** Re-execute the most recently undone action. */
  const redoLast = useCallback(async () => {
    if (future.length === 0) return;
    const last = future[future.length - 1];
    try {
      await last.redo();
      setFuture(prev => prev.slice(0, -1));
      setPast(prev => [...prev.slice(-(MAX_HISTORY - 1)), last]);
    } catch (err) {
      console.error('[UndoHistory] Redo failed:', err);
    }
  }, [future]);

  // Global keyboard shortcuts (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z).
  // Suppressed when a text input / textarea / contenteditable is focused.
  useEffect(() => {
    const handle = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoLast();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redoLast();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [undoLast, redoLast]);

  return (
    <UndoHistoryContext.Provider value={{ past, future, pushAction, clearHistory, undoLast, redoLast }}>
      {children}
    </UndoHistoryContext.Provider>
  );
}

export function useUndoHistory() {
  const ctx = useContext(UndoHistoryContext);
  if (!ctx) throw new Error('useUndoHistory must be used within UndoHistoryProvider');
  return ctx;
}
