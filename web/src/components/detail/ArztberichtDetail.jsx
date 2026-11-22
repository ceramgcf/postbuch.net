import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, Check, X } from 'lucide-react';
import { useUpdateArztbericht } from '@/hooks/usePostbuch';
import { useAuth } from '@/hooks/useAuth';

/**
 * Inline-Editor für ein Freitextfeld des Arztberichts. Mehrzeilige Felder
 * (Befunde) bekommen ein Textfeld statt einer Eingabezeile.
 */
function BerichtFeld({ label, value, postid, field, mehrzeilig = false, leerText = '–', className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const { mutate, isPending, error, reset } = useUpdateArztbericht();
  const { canWrite } = useAuth();

  function startEdit() {
    setDraft(value ?? '');
    reset();
    setEditing(true);
  }

  function save() {
    mutate({ postid, [field]: draft.trim() === '' ? null : draft }, { onSuccess: () => setEditing(false) });
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <dt className="text-muted-foreground">{label}</dt>
        {!editing && canWrite && (
          <button onClick={startEdit} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors" title={`${label} bearbeiten`}>
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          {mehrzeilig ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              autoFocus
            />
          ) : (
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-sm w-full max-w-[320px]" autoFocus />
          )}
          {error && <p className="text-xs text-destructive">{error.message}</p>}
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={save} disabled={isPending} className="h-6 px-2.5 text-xs gap-1">
              <Check className="h-3 w-3" />{isPending ? 'Speichern…' : 'Speichern'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-muted-foreground">
              <X className="h-3 w-3" />Abbrechen
            </Button>
          </div>
        </div>
      ) : value ? (
        <dd className={`whitespace-pre-wrap leading-relaxed ${className || 'font-medium'}`}>{value}</dd>
      ) : (
        <dd className="text-muted-foreground italic">{leerText}</dd>
      )}
    </div>
  );
}

export function ArztberichtDetail({ data }) {
  if (!data) return null;

  const istTier = !!data.behandelte_person_ist_tier;
  const postid = data.postid;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{istTier ? 'Tierarztbericht' : 'Arztbericht'}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-1 gap-y-3">
              <BerichtFeld label={istTier ? 'Behandeltes Tier' : 'Behandelte Person'} value={data.behandelte_person} postid={postid} field="behandelte_person" />
              <BerichtFeld label="Anlass" value={data.anlass} postid={postid} field="anlass" />
            </dl>

            <div>
              <h4 className="font-semibold text-foreground mb-2">Befunde</h4>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <BerichtFeld
                  label="Normbefunde" value={data.norm_befunde} postid={postid} field="norm_befunde"
                  mehrzeilig leerText="Keine Normbefunde erfasst" className="text-foreground/80"
                />
                <BerichtFeld
                  label="Pathologische Befunde" value={data.pathologische_befunde} postid={postid} field="pathologische_befunde"
                  mehrzeilig leerText="Keine pathologischen Befunde" className="text-red-600"
                />
              </dl>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
