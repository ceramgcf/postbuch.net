import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * Clientseitig persistierte Spalten-Konfiguration (Sichtbarkeit + Breite) für Tabellen.
 *
 * Vorbild: hooks/usePerPage.js (lazy init + try/catch). Persistiert werden bewusst nur
 * ABWEICHUNGEN vom Code-Default ({ v, hidden, widths }); die kanonische Spaltenmenge und
 * -reihenfolge bleibt `baseColumns` im Code. So sind neue Spalten automatisch sichtbar und
 * entfernte Spalten werden ignoriert, ohne Migration.
 *
 * @param {string} tableId  – eindeutige ID der Tabelle (→ localStorage-Key)
 * @param {Array}  baseColumns – kanonische Spaltendefinition mit optional
 *                 { defaultWidth, minWidth, maxWidth, elastic, hideable }
 */

const SCHEMA_VERSION = 1;
const KEY_PREFIX = 'postbuch-columns-';
const ABS_MIN = 40;
const ABS_MAX = 600;

function clampWidth(col, px) {
  const min = col.minWidth ?? ABS_MIN;
  const max = col.maxWidth ?? ABS_MAX;
  return Math.max(min, Math.min(max, Math.round(px)));
}

function readStored(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { hidden: [], widths: {} };
    const parsed = JSON.parse(raw);
    // Bei Shape-Mismatch defensiv verwerfen statt crashen.
    if (!parsed || parsed.v !== SCHEMA_VERSION) return { hidden: [], widths: {} };
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      widths: parsed.widths && typeof parsed.widths === 'object' ? parsed.widths : {},
    };
  } catch {
    return { hidden: [], widths: {} };
  }
}

export function useColumnConfig(tableId, baseColumns) {
  const storageKey = KEY_PREFIX + tableId;
  const [stored, setStored] = useState(() => readStored(storageKey));

  // Persistieren (nur wenn es echte Abweichungen gibt → sonst Key entfernen, sauber halten).
  useEffect(() => {
    try {
      const hasDeviation = stored.hidden.length > 0 || Object.keys(stored.widths).length > 0;
      if (hasDeviation) {
        localStorage.setItem(storageKey, JSON.stringify({ v: SCHEMA_VERSION, ...stored }));
      } else {
        localStorage.removeItem(storageKey);
      }
    } catch {
      /* localStorage nicht verfügbar → still ignorieren */
    }
  }, [storageKey, stored]);

  // Gemergte Spalten-Metadaten in baseColumns-Reihenfolge.
  const columns = useMemo(() => {
    const hidden = new Set(stored.hidden);
    return baseColumns.map((col) => ({
      ...col,
      visible: !hidden.has(col.key),
      width:
        stored.widths[col.key] != null
          ? clampWidth(col, stored.widths[col.key])
          : (col.defaultWidth ?? null),
    }));
  }, [baseColumns, stored]);

  const visibleCount = useMemo(() => columns.filter((c) => c.visible).length, [columns]);

  const toggleVisible = useCallback(
    (key) => {
      setStored((prev) => {
        const hidden = new Set(prev.hidden);
        if (hidden.has(key)) {
          hidden.delete(key);
        } else {
          // „Mindestens eine Spalte muss sichtbar bleiben."
          const visibleNow = baseColumns.filter((c) => !hidden.has(c.key)).length;
          if (visibleNow <= 1) return prev;
          hidden.add(key);
        }
        return { ...prev, hidden: [...hidden] };
      });
    },
    [baseColumns],
  );

  const setWidth = useCallback(
    (key, px) => {
      const col = baseColumns.find((c) => c.key === key);
      if (!col) return;
      setStored((prev) => ({ ...prev, widths: { ...prev.widths, [key]: clampWidth(col, px) } }));
    },
    [baseColumns],
  );

  const resetWidth = useCallback((key) => {
    setStored((prev) => {
      if (prev.widths[key] == null) return prev;
      const widths = { ...prev.widths };
      delete widths[key];
      return { ...prev, widths };
    });
  }, []);

  const reset = useCallback(() => {
    setStored({ hidden: [], widths: {} });
  }, []);

  return { columns, visibleCount, toggleVisible, setWidth, resetWidth, reset };
}
