import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatDate(dateStr) {
  if (!dateStr) return '–';
  // Append local-time marker for date-only strings to prevent UTC-midnight parsing.
  // new Date("2024-01-15") is parsed as UTC midnight → in CET (UTC+1) that's Jan 14 23:00
  // → toLocaleDateString would show "14.01.2024" instead of "15.01.2024".
  const d = dateStr.length === 10 ? new Date(dateStr + 'T00:00:00') : new Date(dateStr);
  return d.toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

export function formatCurrency(value) {
  if (value == null) return '–';
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}

export function daysOverdue(faelligkeit) {
  if (!faelligkeit) return null;
  // Compare date strings directly (YYYY-MM-DD) to avoid UTC offset issues
  const dueStr = faelligkeit.slice(0, 10);
  const d = new Date();
  const nowStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (dueStr >= nowStr) return null;
  const due = new Date(dueStr + 'T00:00:00');
  const now = new Date(nowStr + 'T00:00:00');
  return Math.round((now - due) / (1000 * 60 * 60 * 24));
}

export function formatIban(iban) {
  if (!iban) return null;
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (s.length <= 2) return s;
  const last2 = s.slice(-2);
  const rest = s.slice(0, -2);
  const groups = rest.match(/.{1,4}/g) || [];
  return groups.concat([last2]).join(' ');
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffH < 1) return 'vor wenigen Minuten';
  if (diffH < 24) return `vor ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'gestern';
  return `vor ${diffD} Tagen`;
}
