import { useState, useCallback } from 'react';

const STORAGE_KEY = 'postbuch-per-page';
const DEFAULT_PER_PAGE = 'auto';
const VALID_OPTIONS = [10, 12, 15, 20, 50, 100, 200];

export function usePerPage() {
  const [perPage, setPerPageState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'auto') return 'auto';
      const num = parseInt(stored, 10);
      return VALID_OPTIONS.includes(num) ? num : DEFAULT_PER_PAGE;
    } catch {
      return DEFAULT_PER_PAGE;
    }
  });

  const setPerPage = useCallback((value) => {
    if (value === 'auto') {
      setPerPageState('auto');
      localStorage.setItem(STORAGE_KEY, 'auto');
    } else {
      const num = parseInt(value, 10);
      if (VALID_OPTIONS.includes(num)) {
        setPerPageState(num);
        localStorage.setItem(STORAGE_KEY, String(num));
      }
    }
  }, []);

  return [perPage, setPerPage];
}

export { VALID_OPTIONS as PER_PAGE_OPTIONS };
