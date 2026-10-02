import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSaldenList, useCreateSaldo, useDeleteSaldo } from '@/hooks/useSalden';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatCurrency, formatDate } from '@/lib/utils';
import { renderRichText } from '@/lib/richText';
import { useAuth } from '@/hooks/useAuth';
import { Scale, Plus, Trash2, TrendingUp, TrendingDown, ArrowRightLeft } from 'lucide-react';

function SaldoCard({ saldo, onDelete }) {
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const val = parseFloat(saldo.aktueller_saldo) || 0;
  const isPositive = val >= 0;

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-all duration-200 hover:border-primary/30 group"
      onClick={() => navigate(`/analyse/salden/${saldo.saldo_id}`)}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-base truncate group-hover:text-primary transition-colors">
              {saldo.name}
            </h3>
            {saldo.beschreibung && (
              <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{saldo.beschreibung}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <div className={`text-xl font-bold tabular-nums ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
              {formatCurrency(val)}
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {isPositive ? <TrendingUp className="h-3 w-3 text-emerald-500" /> : <TrendingDown className="h-3 w-3 text-red-500" />}
              <span>{saldo.anzahl_buchungen} Buchung{saldo.anzahl_buchungen !== 1 ? 'en' : ''}</span>
            </div>
          </div>
        </div>

        {/* Last 5 bookings */}
        {saldo.letzte_buchungen && saldo.letzte_buchungen.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/40 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Letzte Buchungen</p>
            {saldo.letzte_buchungen.map((b, i) => (
              <div key={i} className="flex items-center justify-between text-xs gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${b.saldo_art === 'positiv' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="text-muted-foreground flex-shrink-0">{formatDate(b.datum)}</span>
                  <span className="truncate">{renderRichText(b.zweck, navigate, '/analyse/salden')}</span>
                </div>
                <span className={`font-mono flex-shrink-0 ${b.saldo_art === 'positiv' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {b.saldo_art === 'positiv' ? '+' : '−'}{formatCurrency(Math.abs(b.betrag))}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Delete button – hidden for read-only users */}
        {canWrite && (
          <div className="mt-3 pt-2 border-t border-border/20 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-red-600 hover:bg-red-50 h-7 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(saldo);
              }}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Archivieren
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SaldenPage() {
  const { data, isLoading, error } = useSaldenList();
  const createMutation = useCreateSaldo();
  const deleteMutation = useDeleteSaldo();
  const { canWrite } = useAuth();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBeschreibung, setNewBeschreibung] = useState('');

  const [deleteTarget, setDeleteTarget] = useState(null);

  const salden = data?.data || [];

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await createMutation.mutateAsync({ name: newName, beschreibung: newBeschreibung || undefined });
      setShowCreate(false);
      setNewName('');
      setNewBeschreibung('');
    } catch {}
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.saldo_id);
      setDeleteTarget(null);
    } catch {}
  };

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <GlowHeading>Salden</GlowHeading>
          <p className="text-muted-foreground mt-1">
            Übersicht aller aktiven Salden mit Buchungsständen.
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setShowCreate(true)} size="sm">
            <Plus className="h-4 w-4 mr-1" />
            Neues Saldo
          </Button>
        )}
      </div>

      {salden.length === 0 ? (
        <EmptyState
          icon={Scale}
          title="Keine Salden"
          description="Erstelle ein neues Saldo, um Buchungen zu verfolgen."
        >
          <Button onClick={() => setShowCreate(true)} size="sm" className="mt-2">
            <Plus className="h-4 w-4 mr-1" />
            Erstes Saldo anlegen
          </Button>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {salden.map((saldo) => (
            <SaldoCard key={saldo.saldo_id} saldo={saldo} onDelete={setDeleteTarget} />
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogTitle>Neues Saldo anlegen</DialogTitle>
        <DialogDescription>Gib einen Namen und optional eine Beschreibung an.</DialogDescription>
        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium">Name *</label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="z. B. Transferbuchung Gesundheitskosten"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Beschreibung</label>
            <textarea
              value={newBeschreibung}
              onChange={(e) => setNewBeschreibung(e.target.value)}
              placeholder="Optionale Erläuterung zum Saldo..."
              className="flex w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-primary/40"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowCreate(false)}>Abbrechen</Button>
          <Button onClick={handleCreate} disabled={!newName.trim() || createMutation.isPending}>
            {createMutation.isPending ? 'Erstelle…' : 'Anlegen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogTitle>Saldo archivieren?</DialogTitle>
        <DialogDescription>
          „{deleteTarget?.name}" wird aus der Übersicht ausgeblendet, aber nicht gelöscht.
          Ein Administrator kann es wiederherstellen.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>Abbrechen</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? 'Archiviere…' : 'Archivieren'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
