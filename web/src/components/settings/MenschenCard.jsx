import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, ArchiveRestore, Eye, KeyRound, PawPrint, Pencil, ShieldCheck, Trash2, UserPlus, Users,
} from 'lucide-react';
import MenschLoeschenDialog from '@/components/settings/MenschLoeschenDialog';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

const FARBEN = ['#0e7490', '#c026d3', '#0284c7', '#16a34a', '#ea580c', '#dc2626', '#7c3aed', '#65a30d'];
const ROLLEN = { vollzugriff: 'Vollzugriff', lesezugriff: 'Lesezugriff' };

function leererMensch() {
  return {
    kurzname: '', anzeigename: '', email: '', farbe: null,
    ist_tier: false, pkv: false, beihilfe: false, pkv_satz: '', beihilfe_satz: '',
    loginfaehig: false, anmeldename: '', rolle: 'lesezugriff', lesebereich: 'alle', password: '',
  };
}

function alsForm(mensch) {
  if (!mensch) return leererMensch();
  return {
    kurzname: mensch.kurzname || '',
    anzeigename: mensch.anzeigename || '',
    email: mensch.email || '',
    farbe: mensch.farbe || null,
    ist_tier: !!mensch.ist_tier,
    pkv: !!mensch.pkv,
    beihilfe: !!mensch.beihilfe,
    pkv_satz: mensch.pkv_satz ?? '',
    beihilfe_satz: mensch.beihilfe_satz ?? '',
    loginfaehig: !!mensch.loginfaehig,
    anmeldename: mensch.anmeldename || mensch.kurzname || '',
    rolle: mensch.rolle || 'lesezugriff',
    lesebereich: mensch.lesebereich || 'alle',
    password: '',
  };
}

function ZugangBadge({ mensch }) {
  if (mensch.loginfaehig) {
    if (mensch.rolle === 'vollzugriff') return <Badge><ShieldCheck className="mr-1 h-3.5 w-3.5" />Vollzugriff</Badge>;
    if (mensch.rolle === 'lesezugriff') {
      return <Badge variant="secondary"><Eye className="mr-1 h-3.5 w-3.5" />{mensch.lesebereich === 'eigene' ? 'Lesezugriff: eigene Dokumente' : 'Lesezugriff'}</Badge>;
    }
    return <Badge>{ROLLEN[mensch.rolle] || mensch.rolle}</Badge>;
  }
  if (mensch.anmeldename) return <Badge variant="secondary">Zugang deaktiviert</Badge>;
  return <Badge variant="outline">Kein Zugang</Badge>;
}

/**
 * @param {object} [props.vorlage] - Vorbelegung für eine neue Person (z. B. aus einer Dokumentenübergabe)
 * @param {(kurzname: string) => void} [props.onGespeichert] - nach erfolgreichem Speichern
 */
export function MenschDialog({ mensch, open, onOpenChange, vorlage = null, onGespeichert }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(() => ({ ...alsForm(mensch), ...(vorlage || {}) }));
  const [error, setError] = useState('');
  const istNeu = !mensch;

  const speichern = useMutation({
    mutationFn: (payload) => istNeu ? api.menschen.create(payload) : api.menschen.update(mensch.id, payload),
    onSuccess: (_data, payload) => {
      onGespeichert?.(payload.kurzname);
      qc.invalidateQueries({ queryKey: ['menschen'] });
      qc.invalidateQueries({ queryKey: ['personen'] });
      qc.invalidateQueries({ queryKey: ['einrichtung'] });
      onOpenChange(false);
    },
    onError: (err) => setError(err.message),
  });

  function set(key, value) {
    setForm((alt) => ({ ...alt, [key]: value }));
  }

  function submit(event) {
    event.preventDefault();
    setError('');
    if (!form.kurzname.trim() || !form.anzeigename.trim()) {
      setError('Kurzname und Vollname sind erforderlich.');
      return;
    }
    if (form.loginfaehig && !(form.anmeldename || form.kurzname).trim()) {
      setError('Für den Zugang ist ein Anmeldename erforderlich.');
      return;
    }
    if (form.loginfaehig && !mensch?.anmeldename && form.password.length < 6) {
      setError('Für einen neuen Zugang ist ein Passwort mit mindestens 6 Zeichen erforderlich.');
      return;
    }
    const payload = {
      kurzname: form.kurzname.trim(),
      anzeigename: form.anzeigename.trim(),
      email: form.email.trim() || null,
      farbe: form.farbe,
      ist_tier: form.ist_tier,
      pkv: form.pkv,
      beihilfe: form.ist_tier ? false : form.beihilfe,
      pkv_satz: form.pkv && form.pkv_satz !== '' ? Number(form.pkv_satz) : null,
      beihilfe_satz: form.beihilfe && form.beihilfe_satz !== '' ? Number(form.beihilfe_satz) : null,
      loginfaehig: form.ist_tier ? false : form.loginfaehig,
      anmeldename: (form.anmeldename || form.kurzname).trim(),
      rolle: form.rolle,
      lesebereich: form.rolle === 'lesezugriff' ? form.lesebereich : 'alle',
    };
    if (form.password) payload.password = form.password;
    speichern.mutate(payload);
  }

  return (
    <Dialog open={open} size="lg" onOpenChange={(wert) => { if (!speichern.isPending) onOpenChange(wert); }}>
      <DialogTitle>{istNeu ? 'Mensch oder Tier anlegen' : `${mensch.anzeigename} bearbeiten`}</DialogTitle>
      <DialogDescription>
        Fachlicher Mensch bzw. tierischer Patient und optionaler App-Zugang werden gemeinsam verwaltet.
      </DialogDescription>
      <form onSubmit={submit} className="mt-4 max-h-[75vh] space-y-4 overflow-y-auto pr-1" autoComplete="off">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="text-xs font-medium">Vollname</label><Input value={form.anzeigename} onChange={(e) => set('anzeigename', e.target.value)} autoFocus /></div>
          <div><label className="text-xs font-medium">Kurzname</label><Input value={form.kurzname} onChange={(e) => { set('kurzname', e.target.value); if (!form.anmeldename || form.anmeldename === form.kurzname) set('anmeldename', e.target.value); }} autoCapitalize="none" /></div>
          <div className="sm:col-span-2"><label className="text-xs font-medium">E-Mail (optional)</label><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
        </div>

        <div>
          <label className="text-xs font-medium">Farbe</label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {FARBEN.map((farbe) => <button key={farbe} type="button" aria-label={`Farbe ${farbe}`} onClick={() => set('farbe', farbe)} className={`h-7 w-7 rounded-full border ${form.farbe === farbe ? 'ring-2 ring-primary ring-offset-2' : ''}`} style={{ backgroundColor: farbe }} />)}
            {form.farbe && <Button type="button" size="sm" variant="ghost" onClick={() => set('farbe', null)}>Zurücksetzen</Button>}
          </div>
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={form.ist_tier} onChange={(e) => { set('ist_tier', e.target.checked); if (e.target.checked) { set('beihilfe', false); set('beihilfe_satz', ''); set('loginfaehig', false); } }} />Tier (tierischer Patient)</label>
          <p className="text-sm font-medium">Versicherung</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.pkv} onChange={(e) => set('pkv', e.target.checked)} />{form.ist_tier ? 'Tier-PKV' : 'PKV'}</label>
            {form.pkv && <Input type="number" min="0" max="100" step="0.01" value={form.pkv_satz} onChange={(e) => set('pkv_satz', e.target.value)} placeholder="PKV-Satz in %" />}
            {!form.ist_tier && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.beihilfe} onChange={(e) => set('beihilfe', e.target.checked)} />Beihilfe</label>
            {form.beihilfe && <Input type="number" min="0" max="100" step="0.01" value={form.beihilfe_satz} onChange={(e) => set('beihilfe_satz', e.target.value)} placeholder="Beihilfe-Satz in %" />}</>}
          </div>
        </div>

        {!form.ist_tier && <div className="rounded-lg border p-3 space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm font-medium">
            <span className="flex items-center gap-2"><KeyRound className="h-4 w-4" />Anmeldung erlauben</span>
            <input type="checkbox" checked={form.loginfaehig} onChange={(e) => set('loginfaehig', e.target.checked)} />
          </label>
          {form.loginfaehig ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="text-xs font-medium">Anmeldename</label><Input value={form.anmeldename} onChange={(e) => set('anmeldename', e.target.value)} autoCapitalize="none" /></div>
              <div><label className="text-xs font-medium">Rolle</label><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.rolle} onChange={(e) => set('rolle', e.target.value)}><option value="lesezugriff">Lesezugriff</option><option value="vollzugriff">Vollzugriff</option></select></div>
              {form.rolle === 'lesezugriff' && (
                <div className="sm:col-span-2">
                  <label className="text-xs font-medium">Sieht</label>
                  <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.lesebereich} onChange={(e) => set('lesebereich', e.target.value)}>
                    <option value="alle">Alle Dokumente</option>
                    <option value="eigene">Nur eigene Dokumente</option>
                  </select>
                  {form.lesebereich === 'eigene' && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nur Dokumente, denen diese Person zugeordnet ist. Suche und Hilfe bleiben verfügbar; Akten, Analysen, Assistent, Export und Benachrichtigungen entfallen.
                    </p>
                  )}
                </div>
              )}
              <div className="sm:col-span-2"><label className="text-xs font-medium">{mensch?.anmeldename ? 'Neues Passwort (optional)' : 'Passwort'}</label><Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={mensch?.anmeldename ? 'Leer lassen, um es beizubehalten' : 'Mindestens 6 Zeichen'} /></div>
            </div>
          ) : mensch?.loginfaehig ? (
            <p className="text-xs text-amber-700">Beim Speichern werden alle Web-Sitzungen beendet und MCP-Tokens deaktiviert.</p>
          ) : <p className="text-xs text-muted-foreground">Diese Person kann fachlich Dokumenten zugeordnet werden, hat aber keinen App-Zugang.</p>}
        </div>}

        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={speichern.isPending}>Abbrechen</Button>
          <Button type="submit" disabled={speichern.isPending}>{speichern.isPending ? 'Speichere…' : 'Speichern'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function MenschZeile({ mensch }) {
  const qc = useQueryClient();
  const [editieren, setEditieren] = useState(false);
  const [loeschen, setLoeschen] = useState(false);
  const archivieren = useMutation({
    mutationFn: () => {
      const wirdArchiviert = !mensch.archiviert;
      if (wirdArchiviert && mensch.loginfaehig && !window.confirm('Archivieren deaktiviert auch den App-Zugang und beendet bestehende Sitzungen. Fortfahren?')) return null;
      return api.menschen.update(mensch.id, { archiviert: wirdArchiviert, ...(wirdArchiviert && mensch.loginfaehig ? { loginfaehig: false } : {}) });
    },
    onSuccess: (result) => {
      if (result === null) return;
      qc.invalidateQueries({ queryKey: ['menschen'] });
      qc.invalidateQueries({ queryKey: ['personen'] });
    },
  });
  const kontaktCount = Number(mensch.adr_count || 0);
  const patientCount = Number(mensch.patient_doc_count || 0);
  const personParam = encodeURIComponent(mensch.kurzname);
  return (
    <div className={`border-b border-border/50 py-3 last:border-0 ${mensch.archiviert ? 'opacity-65' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-3.5 w-3.5 rounded-full border" style={{ backgroundColor: mensch.farbe || '#6b7280' }} />
            <span className="font-medium">{mensch.anzeigename}</span>
            {mensch.ist_tier && <Badge variant="secondary"><PawPrint className="mr-1 h-3.5 w-3.5" />Tier</Badge>}
            <span className="text-xs text-muted-foreground">{mensch.kurzname}</span>
            <ZugangBadge mensch={mensch} />
            {mensch.archiviert && <Badge variant="secondary">Archiviert</Badge>}
            {mensch.pkv && <Badge variant="outline">PKV{mensch.pkv_satz != null ? ` ${mensch.pkv_satz} %` : ''}</Badge>}
            {mensch.beihilfe && <Badge variant="outline">Beihilfe{mensch.beihilfe_satz != null ? ` ${mensch.beihilfe_satz} %` : ''}</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {mensch.loginfaehig ? `Anmeldung: ${mensch.anmeldename}` : mensch.anmeldename ? `Zugang ${mensch.anmeldename} ist deaktiviert` : 'Nur fachliche Zuordnung'}
            {kontaktCount > 0 && (
              <>
                {' · '}
                <Link
                  to={`/postbuch?person=${personParam}&person_as_adressat=true&person_as_patient=false`}
                  className="underline-offset-2 hover:text-primary hover:underline"
                  title="Dokumente im Archiv, in denen diese Person Kontakt (Adressat/Absender) ist"
                >
                  {kontaktCount} als Kontakt
                </Link>
              </>
            )}
            {patientCount > 0 && (
              <>
                {' · '}
                <Link
                  to={`/postbuch?person=${personParam}&person_as_adressat=false&person_as_patient=true`}
                  className="underline-offset-2 hover:text-primary hover:underline"
                  title="Dokumente im Archiv, in denen diese Person Patient (behandelte Person) ist"
                >
                  {patientCount} als Patient
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditieren(true)}><Pencil className="mr-1 h-3.5 w-3.5" />Bearbeiten</Button>
          <Button size="sm" variant="ghost" onClick={() => archivieren.mutate()} disabled={archivieren.isPending}>{mensch.archiviert ? <ArchiveRestore className="mr-1 h-3.5 w-3.5" /> : <Archive className="mr-1 h-3.5 w-3.5" />}{mensch.archiviert ? 'Reaktivieren' : 'Archivieren'}</Button>
          {/* Nur für Archivierte, und optisch abgesetzt: kein Fehlklick neben „Reaktivieren". */}
          {mensch.archiviert && (
            <div className="ml-1 border-l border-border/50 pl-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-500/15 dark:hover:text-red-300"
                onClick={() => setLoeschen(true)}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />Endgültig löschen
              </Button>
            </div>
          )}
        </div>
      </div>
      {archivieren.isError && <p className="mt-1 text-xs text-destructive">{archivieren.error.message}</p>}
      {editieren && <MenschDialog mensch={mensch} open={editieren} onOpenChange={setEditieren} />}
      {loeschen && <MenschLoeschenDialog mensch={mensch} open={loeschen} onOpenChange={setLoeschen} />}
    </div>
  );
}

export default function MenschenCard({ eingebettet = false }) {
  const [anlegen, setAnlegen] = useState(false);
  const { data: menschen = [], isLoading, isError, error } = useQuery({ queryKey: ['menschen'], queryFn: () => api.menschen.list() });
  const aktive = menschen.filter((m) => !m.archiviert);
  const archivierte = menschen.filter((m) => m.archiviert);
  const inhalt = (
    <>
      <div className="mb-4 flex items-start justify-between gap-3 rounded-md border bg-muted/25 p-3">
        <div><p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4" />Systemzugang admin</p><p className="mt-1 text-xs text-muted-foreground">Kein Personen-Datensatz. Das Adminpasswort wird auf dem Server über den Installer geändert.</p></div>
        <Badge variant="outline">Systemzugang</Badge>
      </div>
      <Button size="sm" onClick={() => setAnlegen(true)}><UserPlus className="mr-1.5 h-4 w-4" />Mensch oder Tier anlegen</Button>
      {isLoading ? <p className="py-5 text-sm text-muted-foreground"><Spinner className="mr-2 inline h-4 w-4" />Lade Personen…</p>
        : isError ? <p className="py-5 text-sm text-destructive">{error.message}</p>
          : menschen.length === 0 ? <p className="py-5 text-sm text-muted-foreground">Noch keine Personen angelegt.</p>
            : <div className="mt-4"><p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Aktiv</p>{aktive.map((m) => <MenschZeile key={m.id} mensch={m} />)}{archivierte.length > 0 && <><p className="mb-1 mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Archiviert</p>{archivierte.map((m) => <MenschZeile key={m.id} mensch={m} />)}</>}</div>}
      {anlegen && <MenschDialog open={anlegen} onOpenChange={setAnlegen} />}
    </>
  );
  if (eingebettet) return <div>{inhalt}</div>;
  return <Card><CardHeader><div className="flex items-center gap-2"><Users className="h-5 w-5 text-primary" /><CardTitle className="text-base">Personen &amp; Zugänge</CardTitle></div><CardDescription>Fachliche Personen, Versicherungsdaten und optionale App-Zugänge werden gemeinsam verwaltet.</CardDescription></CardHeader><CardContent>{inhalt}</CardContent></Card>;
}
