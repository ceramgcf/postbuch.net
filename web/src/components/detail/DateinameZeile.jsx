/**
 * DateinameZeile.jsx – Dateiname des Dokuments in der Ablage, umbenennbar.
 *
 * Bearbeitet wird nur der vordere Teil; Kennung und Endung ergänzt das System.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, X } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';

export function DateinameZeile({ postid }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const key = ['postbuch', 'dateiname', postid];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.postbuch.dateiname.get(postid), retry: false });
  const [entwurf, setEntwurf] = useState(null); // null = nicht in Bearbeitung
  const [fehler, setFehler] = useState(null);

  const umbenennen = useMutation({
    mutationFn: () => api.postbuch.dateiname.aendern(postid, entwurf),
    onSuccess: (ergebnis) => {
      qc.setQueryData(key, { dateiname: ergebnis.dateiname, stamm: ergebnis.stamm });
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      setEntwurf(null);
      setFehler(null);
    },
    onError: (err) => setFehler(err.message),
  });

  if (!data?.dateiname) return null;
  const bearbeitet = entwurf !== null;

  // Klein im Fuß der Basisdaten: braucht man selten, soll keinen Raum nehmen.
  if (!bearbeitet) {
    return (
      <div className="flex min-w-0 max-w-full items-center gap-1 text-[11px] text-muted-foreground/50">
        <span className="truncate" title={data.dateiname}>Datei: {data.dateiname}</span>
        {canWrite && (
          <button
            type="button"
            onClick={() => { setEntwurf(data.stamm || ''); setFehler(null); }}
            className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
            title="Dateiname ändern"
            aria-label="Dateiname ändern"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="w-full text-sm">
      <p className="mb-1 text-[11px] text-muted-foreground">Dateiname in der Ablage</p>
      <form
        onSubmit={(ev) => { ev.preventDefault(); if (!umbenennen.isPending) umbenennen.mutate(); }}
        className="space-y-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            autoFocus value={entwurf} maxLength={300}
            onChange={(ev) => setEntwurf(ev.target.value)}
            disabled={umbenennen.isPending}
            className="min-w-0 flex-1 basis-56"
            aria-label="Name ohne Kennung und Endung"
          />
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{postid}.pdf</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Kennung und Endung bleiben. Unzulässige Zeichen werden entfernt, ein sehr langer Name wird gekürzt.
        </p>
        {fehler && <p className="text-xs text-red-600 dark:text-red-400">{fehler}</p>}
        <div className="flex items-center gap-1.5">
          <Button type="submit" size="sm" disabled={umbenennen.isPending} className="h-6 gap-1 px-2.5 text-xs">
            <Check className="h-3 w-3" />
            {umbenennen.isPending ? 'Benenne um…' : 'Umbenennen'}
          </Button>
          <Button
            type="button" variant="ghost" size="sm" disabled={umbenennen.isPending}
            onClick={() => { setEntwurf(null); setFehler(null); }}
            className="h-6 gap-1 px-2 text-xs text-muted-foreground"
          >
            <X className="h-3 w-3" />
            Abbrechen
          </Button>
        </div>
      </form>
    </div>
  );
}
