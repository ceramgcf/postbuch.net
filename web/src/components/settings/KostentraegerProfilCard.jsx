import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileStack, Power, PowerOff, Trash2, ChevronDown, ChevronRight, Sparkles, Download, Upload, RefreshCw, PackagePlus } from 'lucide-react';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

const QUELLE_LABEL = {
  mitgeliefert: 'Mitgeliefert',
  generiert: 'KI-generiert',
  importiert: 'Importiert',
};

function slugify(text) {
  return text.toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'profil';
}

function profilAlsJson(profil) {
  return JSON.stringify(
    { name: profil.name, kostentraeger: profil.kostentraeger, profiltext: profil.profiltext },
    null, 2,
  );
}

function exportiereProfilAlsDatei(profil) {
  const blob = new Blob([profilAlsJson(profil)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kostentraeger-profil-${slugify(profil.name)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Vorschau vor dem Download. Der Profiltext ist KI-erzeugt: Der Profilierungs-
 * Prompt verbietet personenbezogene Daten ausdrücklich, garantieren lässt sich
 * das aber nicht. Wer ein Profil weitergibt, soll es vorher gesehen haben –
 * deshalb der volle Dateiinhalt read-only und scrollbar, direkt an der Stelle,
 * an der geklickt wird.
 */
function ProfilExportDialog({ profil, onClose, onHerunterladen }) {
  if (!profil) return null;
  const json = profilAlsJson(profil);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="xl">
      <DialogTitle>Profil „{profil.name}" exportieren</DialogTitle>
      <DialogDescription>
        Das ist der komplette Inhalt der Datei. Bevor du ihn an Dritte weitergibst – etwa in einem
        GitHub-Issue –, lies ihn bitte durch: Er darf nur beschreiben, wie dieser Kostenträger seine
        Bescheide aufbaut. Namen, Anschriften, Versicherten-, Vorgangs- oder Rechnungsnummern,
        Beträge, Daten und Diagnosen gehören nicht hinein.
      </DialogDescription>
      <textarea
        readOnly
        value={json}
        spellCheck={false}
        className="mt-3 h-64 w-full resize-none overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs"
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Abbrechen</Button>
        <Button onClick={() => { exportiereProfilAlsDatei(profil); onHerunterladen?.(profil.id); onClose(); }}>
          <Download className="mr-1.5 h-3.5 w-3.5" />Herunterladen
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ProfilZeile({ profil, onAktivieren, onDeaktivieren, onLoeschen, onExportieren, onUpdateAnwenden, sicherungGeladen, pending }) {
  const [offen, setOffen] = useState(false);
  const updateVerfuegbar = !!profil.updateVerfuegbar;
  const bereitFuerUpdate = sicherungGeladen.has(profil.id);

  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOffen((v) => !v)}
          className="flex items-center gap-1.5 text-sm font-medium hover:underline"
        >
          {offen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {profil.name}
        </button>
        <Badge variant={profil.aktiv ? 'default' : 'secondary'}>{profil.aktiv ? 'Aktiv' : 'Inaktiv'}</Badge>
        <Badge variant="outline">{QUELLE_LABEL[profil.quelle] || profil.quelle}</Badge>
        {updateVerfuegbar && <Badge variant="destructive">Update verfügbar</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => onExportieren(profil)} title="Profil ansehen und als .json-Datei herunterladen">
            <Download className="mr-1.5 h-3.5 w-3.5" />JSON exportieren
          </Button>
          {profil.aktiv ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onDeaktivieren(profil.id)}>
              <PowerOff className="mr-1.5 h-3.5 w-3.5" />Deaktivieren
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onAktivieren(profil.id)}>
              <Power className="mr-1.5 h-3.5 w-3.5" />Aktivieren
            </Button>
          )}
          <Button
            size="sm" variant="ghost" disabled={pending}
            className="text-destructive hover:text-destructive"
            onClick={() => onLoeschen(profil)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {updateVerfuegbar && (
        <div className="mt-2 rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs">
          <p className="text-muted-foreground">
            postbuch.net liefert für dieses Profil inzwischen eine überarbeitete Fassung mit. Deine
            aktuelle Version wird dadurch nicht automatisch verändert. Lade zuerst eine Sicherung der
            jetzigen Fassung herunter, danach kannst du die neue Fassung übernehmen.
          </p>
          <Button
            size="sm" variant="outline" className="mt-2 mr-1.5" disabled={pending}
            onClick={() => onExportieren(profil)}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />Sicherung herunterladen
          </Button>
          <Button
            size="sm" className="mt-2" disabled={pending || !bereitFuerUpdate}
            title={bereitFuerUpdate ? undefined : 'Zuerst die Sicherung der aktuellen Fassung herunterladen'}
            onClick={() => onUpdateAnwenden(profil.id)}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Update übernehmen
          </Button>
        </div>
      )}
      {offen && (
        <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{profil.profiltext}</p>
      )}
    </div>
  );
}

/**
 * Katalog-Einträge sind mitgelieferte Profile, die (noch) nicht als DB-Zeile
 * materialisiert wurden – sie leben nur als Code (kostentraeger-profil-katalog.js).
 * Erst "Aktivieren" legt die Zeile an und schaltet sie scharf; danach taucht der
 * Eintrag hier nicht mehr auf, sondern nur noch oben in der normalen Liste.
 */
function KatalogBereich({ onAktivieren, pending }) {
  const { data: katalog, isLoading } = useQuery({
    queryKey: ['kostentraeger-profile', 'katalog'],
    queryFn: () => api.kostentraegerProfile.katalog(),
  });

  const verfuegbar = (katalog || []).filter((e) => !e.materialisiert);
  if (isLoading || verfuegbar.length === 0) return null;

  return (
    <div className="rounded-md border border-dashed border-border p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <PackagePlus className="h-3.5 w-3.5 text-primary" />Mitgelieferte Profile verfügbar
      </div>
      <p className="text-xs text-muted-foreground">
        postbuch.net bringt diese Profile bereits fest mit. Sie werden erst mit dieser App-Version
        angeboten und stehen hier so lange nur als Vorlage, bis du sie aktivierst.
      </p>
      <div className="space-y-1.5">
        {verfuegbar.map((eintrag) => (
          <div key={eintrag.schluessel} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
            <span className="text-sm">{eintrag.name}</span>
            <Badge variant="outline">{eintrag.kostentraeger}</Badge>
            <Button
              size="sm" variant="outline" className="ml-auto" disabled={pending}
              onClick={() => onAktivieren(eintrag.schluessel)}
            >
              <Power className="mr-1.5 h-3.5 w-3.5" />Aktivieren
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfilExtrahierenBereich({ onErledigt }) {
  const [akteid, setAkteid] = useState('');
  const [ergebnis, setErgebnis] = useState(null);
  const [fehler, setFehler] = useState('');

  const { data: akten, isLoading: aktenLoading } = useQuery({
    queryKey: ['kostentraeger-profile', 'kandidaten-akten'],
    queryFn: () => api.kostentraegerProfile.kandidatenAkten(),
  });

  const profilierenMutation = useMutation({
    mutationFn: (id) => api.kostentraegerProfile.profilieren(id),
    onSuccess: (data) => {
      setFehler('');
      setErgebnis(data);
      onErledigt();
    },
    onError: (err) => { setErgebnis(null); setFehler(err.message); },
  });

  return (
    <div className="rounded-md border border-dashed border-border p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="h-3.5 w-3.5 text-primary" />Profil extrahieren
      </div>
      <p className="text-xs text-muted-foreground">
        Wählt aus einer Akte, die ausschließlich Erstattungsbescheide desselben Kostenträgers enthält
        (idealerweise etwa fünf, darunter möglichst welche mit Kürzungen), automatisch ein neues Profil
        ab. Gemischte Akten werden hier nicht angeboten – für eine saubere Ableitung erst eine reine
        Akte für den jeweiligen Kostenträger zusammenstellen.
      </p>
      <div className="flex items-center gap-2">
        <Select
          value={akteid}
          onChange={(e) => { setAkteid(e.target.value); setErgebnis(null); setFehler(''); }}
          className="max-w-sm"
          disabled={aktenLoading || profilierenMutation.isPending}
        >
          <option value="">Akte wählen …</option>
          {(akten || []).map((a) => (
            <option key={a.akteid} value={a.akteid}>
              {a.akteid} – {a.betreff} ({a.dok_anzahl} Dok.)
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={!akteid || profilierenMutation.isPending}
          onClick={() => { setErgebnis(null); setFehler(''); profilierenMutation.mutate(akteid); }}
        >
          {profilierenMutation.isPending && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
          Profilieren
        </Button>
      </div>
      {!aktenLoading && (akten || []).length === 0 && (
        <p className="text-xs text-muted-foreground">
          Keine geeigneten Akten gefunden. Erst eine Akte anlegen, die nur Erstattungsbescheide desselben
          Kostenträgers enthält.
        </p>
      )}
      {fehler && <p className="text-sm text-destructive">{fehler}</p>}
      {ergebnis && (
        <p className="text-sm text-primary">
          Profil „{ergebnis.profil.name}" ({ergebnis.profil.kostentraeger}) erstellt
          {ergebnis.aktiviert ? ' und aktiviert.' : `. ${ergebnis.hinweis || 'Nicht automatisch aktiviert.'}`}
        </p>
      )}
    </div>
  );
}

/**
 * Gegenstück zum Export-Dialog. Beim Export geht es darum, nichts Privates aus
 * dem Haus zu geben; hier darum, nichts Fremdes ungelesen hereinzulassen. Der
 * Profiltext eines importierten Profils geht bei Aktivierung wörtlich in den
 * Auswertungs-Prompt für Erstattungsbescheide ein – wer ihn übernimmt, soll ihn
 * vorher gesehen haben. Gespeichert wird deshalb inaktiv; das Scharfschalten
 * ist ein eigener Klick in der Liste.
 */
function ProfilImportDialog({ daten, onAbbrechen, onBestaetigen, pending }) {
  if (!daten) return null;
  const json = JSON.stringify(daten, null, 2);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onAbbrechen(); }} size="xl">
      <DialogTitle>Profil „{daten?.name || 'ohne Namen'}" importieren</DialogTitle>
      <DialogDescription>
        Das ist der komplette Inhalt der Datei. Er beschreibt, wie ein Kostenträger seine Bescheide
        aufbaut, und fließt nach dem Aktivieren wörtlich in die KI-Auswertung deiner eigenen
        Bescheide ein. Lies ihn durch, bevor du ihn übernimmst – vor allem bei Dateien aus fremder
        Hand. Anweisungen an die KI, Links oder alles, was nichts mit dem Layout des Absenders zu
        tun hat, gehören nicht hinein. Das Profil wird zunächst nur gespeichert und bleibt inaktiv.
      </DialogDescription>
      <textarea
        readOnly
        value={json}
        spellCheck={false}
        className="mt-3 h-64 w-full resize-none overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs"
      />
      <DialogFooter>
        <Button variant="outline" onClick={onAbbrechen}>Abbrechen</Button>
        <Button disabled={pending} onClick={onBestaetigen}>
          {pending && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
          <Upload className="mr-1.5 h-3.5 w-3.5" />Inaktiv speichern
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ProfilImportierenBereich({ onErledigt }) {
  const fileRef = useRef(null);
  const [ergebnis, setErgebnis] = useState(null);
  const [fehler, setFehler] = useState('');
  const [vorschau, setVorschau] = useState(null);

  const importMutation = useMutation({
    mutationFn: (daten) => api.kostentraegerProfile.import(daten),
    onSuccess: (data) => {
      setFehler('');
      setVorschau(null);
      setErgebnis(data);
      onErledigt();
    },
    onError: (err) => { setVorschau(null); setErgebnis(null); setFehler(err.message); },
  });

  function onFileChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErgebnis(null);
    setFehler('');
    const reader = new FileReader();
    reader.onload = () => {
      let daten;
      try {
        daten = JSON.parse(reader.result);
      } catch {
        setFehler('Datei ist kein gültiges JSON.');
        return;
      }
      setVorschau(daten);
    };
    reader.onerror = () => setFehler('Datei konnte nicht gelesen werden.');
    reader.readAsText(file);
  }

  return (
    <div className="rounded-md border border-dashed border-border p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Upload className="h-3.5 w-3.5 text-primary" />Profil importieren
      </div>
      <p className="text-xs text-muted-foreground">
        Lädt ein per „JSON exportieren" erzeugtes Profil aus einer .json-Datei. Der Inhalt wird dir
        zuerst vollständig angezeigt; gespeichert wird das Profil dann inaktiv (Quelle „Importiert").
        Erst wenn du es in der Liste aktivierst, fließt sein Text in die Auswertung deiner Bescheide
        ein – lies ihn vorher durch, besonders bei Dateien aus fremder Hand.
      </p>
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFileChosen} />
      <Button size="sm" variant="outline" disabled={importMutation.isPending} onClick={() => fileRef.current?.click()}>
        {importMutation.isPending && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
        <Upload className="mr-1.5 h-3.5 w-3.5" />.json-Datei wählen …
      </Button>
      {fehler && <p className="text-sm text-destructive">{fehler}</p>}
      {ergebnis && (
        <p className="text-sm text-primary">
          Profil „{ergebnis.profil.name}" ({ergebnis.profil.kostentraeger}) importiert.{' '}
          {ergebnis.hinweis || 'Es ist noch inaktiv – aktiviere es oben in der Liste.'}
        </p>
      )}
      <ProfilImportDialog
        daten={vorschau}
        pending={importMutation.isPending}
        onAbbrechen={() => setVorschau(null)}
        onBestaetigen={() => importMutation.mutate(vorschau)}
      />
    </div>
  );
}

export default function KostentraegerProfilCard() {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [exportProfil, setExportProfil] = useState(null);
  const [sicherungGeladen, setSicherungGeladen] = useState(() => new Set());

  const { data: profile, isLoading } = useQuery({
    queryKey: ['kostentraeger-profile'],
    queryFn: () => api.kostentraegerProfile.list(),
  });

  function invalidieren() {
    qc.invalidateQueries({ queryKey: ['kostentraeger-profile'] });
    qc.invalidateQueries({ queryKey: ['kostentraeger-profile', 'katalog'] });
    qc.invalidateQueries({ queryKey: ['kostentraeger-profile', 'kandidaten-akten'] });
  }

  const aktivierenMutation = useMutation({
    mutationFn: (id) => api.kostentraegerProfile.aktivieren(id),
    onSuccess: () => { setError(''); invalidieren(); },
    onError: (err) => {
      // Zusatzfelder des Servers liegen im geparsten Body (client.js setzt nur
      // status und payload am Error), nicht direkt am Error-Objekt.
      const aktiveNamen = err.payload?.aktiveNamen;
      setError(Array.isArray(aktiveNamen) && aktiveNamen.length
        ? `${err.message} Aktiv: ${aktiveNamen.join(', ')}.`
        : err.message);
    },
  });
  const deaktivierenMutation = useMutation({
    mutationFn: (id) => api.kostentraegerProfile.deaktivieren(id),
    onSuccess: () => { setError(''); invalidieren(); },
    onError: (err) => setError(err.message),
  });
  const loeschenMutation = useMutation({
    mutationFn: (id) => api.kostentraegerProfile.delete(id),
    onSuccess: () => { setError(''); invalidieren(); },
    onError: (err) => setError(err.message),
  });
  const katalogAktivierenMutation = useMutation({
    mutationFn: (schluessel) => api.kostentraegerProfile.katalogAktivieren(schluessel),
    onSuccess: () => { setError(''); invalidieren(); },
    onError: (err) => {
      const aktiveNamen = err.payload?.aktiveNamen;
      setError(Array.isArray(aktiveNamen) && aktiveNamen.length
        ? `${err.message} Aktiv: ${aktiveNamen.join(', ')}.`
        : err.message);
    },
  });
  const updateAnwendenMutation = useMutation({
    mutationFn: (id) => api.kostentraegerProfile.updateAnwenden(id),
    onSuccess: (_data, id) => {
      setError('');
      setSicherungGeladen((s) => { const n = new Set(s); n.delete(id); return n; });
      invalidieren();
    },
    onError: (err) => setError(err.message),
  });

  function handleHerunterladen(id) {
    setSicherungGeladen((s) => new Set(s).add(id));
  }

  function handleLoeschen(profil) {
    if (!window.confirm(`Profil "${profil.name}" wirklich löschen? Bereits erstellte Bescheide behalten ihren bisherigen Text, verlieren aber den Verweis auf dieses Profil.`)) return;
    loeschenMutation.mutate(profil.id);
  }

  const pending = aktivierenMutation.isPending || deaktivierenMutation.isPending
    || loeschenMutation.isPending || katalogAktivierenMutation.isPending || updateAnwendenMutation.isPending;
  const aktiveAnzahl = (profile || []).filter((p) => p.aktiv).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FileStack className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Kostenträger-Profile</CardTitle>
          {isLoading && <Spinner className="h-3.5 w-3.5 ml-auto" />}
        </div>
        <CardDescription className="text-xs pt-1">
          Beschreiben bekannte Layouts einzelner Kostenträger (z. B. eine bestimmte Beihilfestelle) und
          helfen der KI beim Parsen von Erstattungsbescheiden. Ein Profil beschreibt nur das Layout –
          es hebt keine der festen Parsing-Regeln auf. Höchstens 5 Profile können gleichzeitig aktiv sein
          ({aktiveAnzahl}/5 aktiv). Ein Profil lässt sich nicht bearbeiten – bei Bedarf löschen und über
          „Profil extrahieren" neu erzeugen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!isLoading && (profile || []).length === 0 && (
          <p className="text-sm text-muted-foreground">Noch keine Profile vorhanden.</p>
        )}
        {(profile || []).map((profil) => (
          <ProfilZeile
            key={profil.id}
            profil={profil}
            pending={pending}
            sicherungGeladen={sicherungGeladen}
            onAktivieren={(id) => aktivierenMutation.mutate(id)}
            onDeaktivieren={(id) => deaktivierenMutation.mutate(id)}
            onLoeschen={handleLoeschen}
            onExportieren={setExportProfil}
            onUpdateAnwenden={(id) => updateAnwendenMutation.mutate(id)}
          />
        ))}
        <KatalogBereich pending={pending} onAktivieren={(schluessel) => katalogAktivierenMutation.mutate(schluessel)} />
        <ProfilExtrahierenBereich onErledigt={invalidieren} />
        <ProfilImportierenBereich onErledigt={invalidieren} />
        <ProfilExportDialog
          profil={exportProfil}
          onClose={() => setExportProfil(null)}
          onHerunterladen={handleHerunterladen}
        />
      </CardContent>
    </Card>
  );
}
