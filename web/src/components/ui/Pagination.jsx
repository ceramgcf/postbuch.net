import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { PER_PAGE_OPTIONS } from '@/hooks/usePerPage';

/**
 * Reusable pagination controls.
 *
 * Props:
 *   page         – current 1-based page number
 *   totalPages   – total number of pages
 *   perPage      – effective numeric items per page (for range display)
 *   perPageRaw   – stored value ('auto' or number) for the select; defaults to perPage
 *   autoRows     – computed rows when auto mode is active (shown as "Auto (N)")
 *   total        – total item count
 *   onPageChange(page)     – called when page changes
 *   onPerPageChange(value) – called with 'auto' or a number
 *   className    – optional container class
 */
export function Pagination({ page, totalPages, perPage, perPageRaw, autoRows, total, onPageChange, onPerPageChange, className }) {
  const selectValue = perPageRaw ?? perPage;
  const [pageInput, setPageInput] = useState(String(page));
  const inputRef = useRef(null);

  // Keep input in sync when page changes externally – but only if the input is not focused
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setPageInput(String(page));
    }
  }, [page]);

  // `perPage` is the effective number of items visible per page (already accounting for any buffer).
  // Do not apply an additional percentage reduction here – use it directly for the displayed range.
  const adjustedPerPage = Math.max(1, Number(perPage));
  const start = Math.min((page - 1) * adjustedPerPage + 1, total);
  const end = Math.min(page * adjustedPerPage, total);

  const handlePageInputChange = (e) => {
    setPageInput(e.target.value);
  };

  const handlePageInputCommit = () => {
    const num = parseInt(pageInput, 10);
    if (num >= 1 && num <= totalPages) {
      onPageChange(num);
    } else {
      setPageInput(String(page));
    }
  };

  const handlePageInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.target.blur();
      handlePageInputCommit();
    } else if (e.key === 'Escape') {
      setPageInput(String(page));
      e.target.blur();
    }
  };

  if (total <= 0) return null;

  return (
    <div className={`flex items-center justify-between gap-4 text-sm ${className || ''}`}>
      {/* Left: item range */}
      <span className="text-muted-foreground tabular-nums whitespace-nowrap">
        {start}–{end} von {total}
      </span>

      {/* Center: page navigation */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPageChange(1)}
          disabled={page <= 1}
          title="Erste Seite"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          title="Vorherige Seite"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>

        <span className="flex items-center gap-1.5 text-sm whitespace-nowrap px-1">
          Seite
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={handlePageInputChange}
            onBlur={handlePageInputCommit}
            onKeyDown={handlePageInputKeyDown}
            className="w-10 h-7 text-center rounded-md border border-input bg-background text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-primary/40"
          />
          von {totalPages}
        </span>

        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          title="Nächste Seite"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPageChange(totalPages)}
          disabled={page >= totalPages}
          title="Letzte Seite"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Right: per-page selector */}
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <Select
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            onPerPageChange(v === 'auto' ? 'auto' : parseInt(v, 10));
          }}
          className="w-[176px] h-7 text-xs"
        >
          <option value="auto">Auto ({autoRows ?? perPage})</option>
          {PER_PAGE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </Select>
        <span className="text-muted-foreground text-xs">pro Seite</span>
      </div>
    </div>
  );
}
