import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Download, KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/** Eingabefeld für den 6-stelligen Code; nimmt auf Wunsch auch Wiederherstellungscodes. */
export function CodeFeld({ value, onChange, wiederherstellung = false, autoFocus = true }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoFocus={autoFocus}
      autoComplete="one-time-code"
      inputMode={wiederherstellung ? 'text' : 'numeric'}
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      maxLength={wiederherstellung ? 24 : 7}
      placeholder={wiederherstellung ? 'XXXX-XXXX-XXXX-XXXX' : '6-stelliger Code'}
      className="h-10 text-center font-mono tracking-widest text-base"
    />
  );
}

/**
 * QR-Code und Abtipp-Schlüssel, danach Bestätigung mit dem ersten Code.
 * `starten()` liefert { uri, geheimnis }, `bestaetigen(code)` die Antwort mit
 * `wiederherstellungscodes`.
 */
export function ZweiterFaktorEinrichtung({ starten, bestaetigen, onFertig, onAbbrechen }) {
  const [daten, setDaten] = useState(null);
  const [code, setCode] = useState('');
  const [fehler, setFehler] = useState('');

  const start = useMutation({
    mutationFn: starten,
    onSuccess: (d) => { setDaten(d); setFehler(''); },
    onError: (err) => setFehler(err.message),
  });
  const pruefen = useMutation({
    mutationFn: () => bestaetigen(code),
    onSuccess: (antwort) => onFertig(antwort),
    onError: (err) => { setFehler(err.message); setCode(''); },
  });

  // Einmal beim Öffnen; ein neuer Aufruf erzeugt ein neues Geheimnis.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { start.mutate(); }, []);

  if (!daten) {
    return fehler
      ? <div className="space-y-2"><p className="text-sm text-destructive">{fehler}</p>{onAbbrechen && <Button variant="outline" size="sm" onClick={onAbbrechen}>Zurück</Button>}</div>
      : <div className="flex justify-center py-6"><Spinner /></div>;
  }

  const schluessel = daten.geheimnis.match(/.{1,4}/g).join(' ');
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => { e.preventDefault(); setFehler(''); pruefen.mutate(); }}
    >
      <ol className="space-y-1 text-sm text-muted-foreground list-decimal pl-5">
        <li>Eine Authenticator-App öffnen, z. B. Microsoft Authenticator, Google Authenticator, Aegis, 2FAS oder den Passwortmanager.</li>
        <li>Den QR-Code scannen oder den Schlüssel von Hand eintragen.</li>
        <li>Den angezeigten 6-stelligen Code hier eingeben.</li>
      </ol>
      <div className="flex flex-col items-center gap-3">
        {/* Weißer Rand auch im dunklen Design: Kameras brauchen den Kontrast. */}
        <a href={daten.uri} className="rounded-lg bg-white p-3" title="Auf dem Telefon: direkt in der Authenticator-App öffnen">
          <QRCodeSVG value={daten.uri} size={176} level="M" />
        </a>
        <code className="select-all break-all text-center text-sm font-mono">{schluessel}</code>
      </div>
      <CodeFeld value={code} onChange={setCode} />
      {fehler && <p className="text-sm text-destructive">{fehler}</p>}
      <div className="flex gap-2">
        {onAbbrechen && <Button type="button" variant="outline" onClick={onAbbrechen} disabled={pruefen.isPending}>Abbrechen</Button>}
        <Button type="submit" className="flex-1" disabled={pruefen.isPending || code.replace(/\s/g, '').length !== 6}>
          {pruefen.isPending ? 'Prüfe…' : 'Bestätigen'}
        </Button>
      </div>
    </form>
  );
}

/** Einmalige Anzeige der Wiederherstellungscodes. Weiter erst nach Bestätigung. */
export function Wiederherstellungscodes({ codes, onWeiter, weiterText = 'Fertig' }) {
  const [gesichert, setGesichert] = useState(false);
  const [kopiert, setKopiert] = useState(false);
  const text = codes.join('\n');

  function herunterladen() {
    const blob = new Blob([`postbuch.net – Wiederherstellungscodes\n\n${text}\n\nJeder Code gilt genau einmal.\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'postbuch-wiederherstellungscodes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        Mit diesen Codes kommst du ohne Telefon an dein Konto. Jeder gilt genau einmal. Sie werden
        nur jetzt angezeigt – bitte sicher aufbewahren, z. B. im Passwortmanager oder ausgedruckt.
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(text).then(() => setKopiert(true)).catch(() => {})}>
          <Copy className="mr-1.5 h-4 w-4" />{kopiert ? 'Kopiert' : 'Kopieren'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={herunterladen}>
          <Download className="mr-1.5 h-4 w-4" />Als Datei
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={gesichert} onChange={(e) => setGesichert(e.target.checked)} />
        Ich habe die Codes gesichert.
      </label>
      <Button type="button" className="w-full" disabled={!gesichert} onClick={onWeiter}>{weiterText}</Button>
    </div>
  );
}

/** Kleines Formular, das vor einer Änderung den aktuellen Code (und ggf. das Passwort) verlangt. */
function Nachweis({ titel, mitPasswort = false, knopf, onAbsenden, onAbbrechen, laeuft, fehler }) {
  const [code, setCode] = useState('');
  const [passwort, setPasswort] = useState('');
  const [wiederherstellung, setWiederherstellung] = useState(false);
  return (
    <form className="space-y-3 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); onAbsenden({ code, passwort }); }}>
      <p className="text-sm font-medium">{titel}</p>
      {mitPasswort && (
        <Input type="password" autoComplete="current-password" placeholder="Passwort" value={passwort} onChange={(e) => setPasswort(e.target.value)} autoFocus />
      )}
      <CodeFeld value={code} onChange={setCode} wiederherstellung={wiederherstellung} autoFocus={!mitPasswort} />
      <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => { setWiederherstellung((w) => !w); setCode(''); }}>
        {wiederherstellung ? 'Code aus der App verwenden' : 'Wiederherstellungscode verwenden'}
      </button>
      {fehler && <p className="text-sm text-destructive">{fehler}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onAbbrechen} disabled={laeuft}>Abbrechen</Button>
        <Button type="submit" size="sm" disabled={laeuft || !code || (mitPasswort && !passwort)}>{laeuft ? 'Prüfe…' : knopf}</Button>
      </div>
    </form>
  );
}

const datum = (wert) => new Date(wert).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Karte unter Einstellungen → Persönlich. */
export default function ZweiterFaktorKarte() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  // ansicht: null | 'einrichten' | 'wechsel-nachweis' | 'wechsel' | 'codes-nachweis' | 'abschalten' | 'codes'
  const [ansicht, setAnsicht] = useState(null);
  const [wechselCode, setWechselCode] = useState('');
  const [neueCodes, setNeueCodes] = useState(null);
  const [fehler, setFehler] = useState('');

  const { data: status, isLoading } = useQuery({ queryKey: ['zweiter-faktor'], queryFn: () => api.zweiterFaktor.status() });

  const neu = () => qc.invalidateQueries({ queryKey: ['zweiter-faktor'] });
  const schliessen = () => { setAnsicht(null); setFehler(''); setWechselCode(''); };

  const wechselPruefen = useMutation({
    // Der Code wird beim Start der Einrichtung geprüft; hier nur weiterreichen.
    mutationFn: async ({ code }) => { setWechselCode(code); },
    onSuccess: () => setAnsicht('wechsel'),
  });
  const codesErneuern = useMutation({
    mutationFn: ({ code }) => api.zweiterFaktor.wiederherstellungscodes(code),
    onSuccess: (d) => { setNeueCodes(d.wiederherstellungscodes); setAnsicht('codes'); setFehler(''); neu(); },
    onError: (err) => setFehler(err.message),
  });
  const abschalten = useMutation({
    mutationFn: ({ code, passwort }) => api.zweiterFaktor.abschalten(passwort, code),
    onSuccess: () => { schliessen(); neu(); },
    onError: (err) => setFehler(err.message),
  });

  const fertig = (antwort) => { setNeueCodes(antwort.wiederherstellungscodes); setAnsicht('codes'); neu(); };

  let inhalt;
  if (isLoading || !status) {
    inhalt = <div className="flex justify-center py-4"><Spinner /></div>;
  } else if (ansicht === 'codes' && neueCodes) {
    inhalt = <Wiederherstellungscodes codes={neueCodes} onWeiter={() => { setNeueCodes(null); schliessen(); }} />;
  } else if (ansicht === 'einrichten' || ansicht === 'wechsel') {
    inhalt = (
      <ZweiterFaktorEinrichtung
        starten={() => api.zweiterFaktor.einrichten(ansicht === 'wechsel' ? wechselCode : undefined)}
        bestaetigen={(code) => api.zweiterFaktor.bestaetigen(code)}
        onFertig={fertig}
        onAbbrechen={schliessen}
      />
    );
  } else if (!status.aktiv) {
    inhalt = (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Zusätzlich zum Passwort fragt die Anmeldung dann einen Code aus einer Authenticator-App auf dem Telefon ab.
          {status.pflicht && ' Für diese Instanz ist das vorgeschrieben.'}
        </p>
        <Button onClick={() => setAnsicht('einrichten')}><ShieldCheck className="mr-1.5 h-4 w-4" />Einrichten</Button>
      </div>
    );
  } else {
    inhalt = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge><ShieldCheck className="mr-1 h-3.5 w-3.5" />Aktiv</Badge>
          {status.eingerichtetAm && <span className="text-muted-foreground">seit {datum(status.eingerichtetAm)}</span>}
          <span className={status.verbleibendeCodes <= 2 ? 'text-destructive' : 'text-muted-foreground'}>
            · {status.verbleibendeCodes === 1 ? '1 Wiederherstellungscode' : `${status.verbleibendeCodes} Wiederherstellungscodes`} übrig
          </span>
        </div>
        {status.defekt && (
          <p className="flex gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            Der gespeicherte Schlüssel ist auf dieser Instanz nicht lesbar, etwa nach dem Einspielen eines unverschlüsselten
            Backups. Codes aus der App werden nicht mehr angenommen. Mit einem Wiederherstellungscode neu einrichten.
          </p>
        )}
        {ansicht === 'wechsel-nachweis' && (
          <Nachweis titel="Aktuellen Code eingeben, um ein neues Gerät einzurichten" knopf="Weiter"
            onAbsenden={wechselPruefen.mutate} onAbbrechen={schliessen} laeuft={false} fehler={fehler} />
        )}
        {ansicht === 'codes-nachweis' && (
          <Nachweis titel="Aktuellen Code eingeben – die bisherigen Wiederherstellungscodes werden dabei ungültig" knopf="Neue Codes erzeugen"
            onAbsenden={codesErneuern.mutate} onAbbrechen={schliessen} laeuft={codesErneuern.isPending} fehler={fehler} />
        )}
        {ansicht === 'abschalten' && (
          <Nachweis titel="Zum Abschalten Passwort und aktuellen Code eingeben" knopf="Abschalten" mitPasswort
            onAbsenden={abschalten.mutate} onAbbrechen={schliessen} laeuft={abschalten.isPending} fehler={fehler} />
        )}
        {!ansicht && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setAnsicht('wechsel-nachweis')}>Neues Gerät einrichten</Button>
            <Button size="sm" variant="outline" onClick={() => setAnsicht('codes-nachweis')}><KeyRound className="mr-1.5 h-4 w-4" />Neue Wiederherstellungscodes</Button>
            {!status.pflicht && <Button size="sm" variant="outline" onClick={() => setAnsicht('abschalten')}>Abschalten</Button>}
          </div>
        )}
        {status.pflicht && !ansicht && (
          <p className="text-xs text-muted-foreground">
            {isAdmin ? 'Ist für alle Zugänge vorgeschrieben (Personen & Zugänge).' : 'Ist für diese Instanz vorgeschrieben und lässt sich nicht abschalten.'}
          </p>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Zwei-Faktor-Anmeldung</CardTitle>
        <CardDescription>Code aus einer Authenticator-App als zweiter Schritt nach dem Passwort.</CardDescription>
      </CardHeader>
      <CardContent>{inhalt}</CardContent>
    </Card>
  );
}
