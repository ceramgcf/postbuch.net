import { useState, useMemo } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router';
import { useUnbezahlt } from '@/hooks/usePostbuch';
import { usePerPage } from '@/hooks/usePerPage';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Pagination } from '@/components/ui/Pagination';
import { ArtBadge } from '@/components/postbuch/ArtBadge';
import { LebensbereichBadge } from '@/components/postbuch/LebensbereichBadge';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatDate, formatCurrency, daysOverdue } from '@/lib/utils';
import { CheckCircle, AlertCircle } from 'lucide-react';

export default function UnbezahltPage() {
  const { data, isLoading, error } = useUnbezahlt();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [perPage, setPerPage] = usePerPage();

  const urlPage = parseInt(searchParams.get('page') || '1', 10);
  const [page, setPageState] = useState(urlPage);

  const rows = data?.data || [];
  // perPage kann 'auto' sein – in dem Fall 50 als Fallback (keine Container-Messung hier).
  const effectivePerPage = perPage === 'auto' ? 50 : Number(perPage);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / effectivePerPage));
  const safePage = Math.min(page, totalPages);

  const pagedRows = useMemo(
    () => rows.slice((safePage - 1) * effectivePerPage, safePage * effectivePerPage),
    [rows, safePage, effectivePerPage],
  );

  // The global index offset for navList/navIndex
  const pageOffset = (safePage - 1) * perPage;

  const handlePageChange = (p) => {
    setPageState(p);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (p <= 1) next.delete('page');
      else next.set('page', String(p));
      return next;
    }, { replace: true });
  };

  const handlePerPageChange = (value) => {
    setPerPage(value);
    handlePageChange(1);
  };

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  const fromPath = location.pathname + location.search;
  const showPagination = total > effectivePerPage;

  const paginationProps = {
    page: safePage,
    totalPages,
    perPage: effectivePerPage,
    total,
    onPageChange: handlePageChange,
    onPerPageChange: handlePerPageChange,
  };

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-5">
      <div>
        <GlowHeading>Unbezahlte Rechnungen</GlowHeading>
        <p className="text-muted-foreground mt-1">
          {rows.length} offene Rechnungen mit einer Gesamtsumme von{' '}
          <span className="font-semibold text-foreground">{formatCurrency(rows.reduce((s, r) => s + parseFloat(r.offener_betrag || 0), 0))}</span>
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={CheckCircle} title="Alles bezahlt!" description="Keine offenen Rechnungen." />
      ) : (
        <>
          {showPagination && <Pagination {...paginationProps} />}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Datum</TableHead>
                <TableHead>Typ</TableHead>
                <TableHead>Absender / Arzt</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead className="text-right">Noch fällig</TableHead>
                <TableHead>Fällig</TableHead>
                <TableHead>Überfällig</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedRows.map((row, idx) => {
                const overdue = daysOverdue(row.faelligkeit);
                const globalIdx = pageOffset + idx;
                return (
                  <TableRow
                    key={row.postid}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/postbuch/${row.postid}`, {
                      state: { from: fromPath, navList: rows, navIndex: globalIdx },
                    })}
                  >
                    <TableCell className="font-mono text-xs text-primary">{row.postid}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(row.briefdatum)}</TableCell>
                    <TableCell><div className="flex items-center gap-1.5"><LebensbereichBadge lebensbereich={row.lebensbereich} compact /><ArtBadge art={row.dokumentart || row.art} /></div></TableCell>
                    <TableCell>{row.name_arzt || row.kontakt || '–'}</TableCell>
                    <TableCell>{row.behandelte_person || '–'}</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(row.offener_betrag)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(row.faelligkeit)}</TableCell>
                    <TableCell>
                      {overdue && (
                        <span className={`text-sm font-medium ${overdue > 30 ? 'text-red-600' : 'text-amber-600'}`}>
                          {overdue} Tage
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {showPagination && <Pagination {...paginationProps} />}
        </>
      )}
    </div>
  );
}
