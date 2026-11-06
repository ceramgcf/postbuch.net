import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { hatGeteilteDateien, hatGeteilteFotos } from '@/lib/geteilteDateien';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { api } from '@/api/client';
import { CodeFeld, ZweiterFaktorEinrichtung, Wiederherstellungscodes } from '@/components/settings/ZweiterFaktor';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState(null); // null = kein Hinweis nötig
  const [lockSeconds, setLockSeconds] = useState(0);       // > 0 = gesperrt, Countdown läuft
  // Zweiter Schritt: null | 'code' | 'einrichtung' | 'codes'
  const [schritt, setSchritt] = useState(null);
  const [code, setCode] = useState('');
  const [wiederherstellung, setWiederherstellung] = useState(false);
  const [abschluss, setAbschluss] = useState(null); // Login-Antwort, die nach der Code-Anzeige übernommen wird
  const [hinweis, setHinweis] = useState('');
  const [neueCodes, setNeueCodes] = useState(null); // Antwort von /login/bestaetigen
  const { login, anmeldungUebernehmen } = useAuth();
  const navigate = useNavigate();
  const [instanceName, setInstanceName] = useState('');

  useEffect(() => {
    fetch('/api/auth/instance-name')
      .then(r => r.ok ? r.json() : {})
      .then(d => setInstanceName(d.instanceName || ''))
      .catch(() => {});
  }, []);

  // Countdown während der Sperre; am Ende wieder freigeben.
  useEffect(() => {
    if (lockSeconds <= 0) return;
    const t = setInterval(() => {
      setLockSeconds((s) => {
        if (s <= 1) { setAttemptsLeft(null); setError(''); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [lockSeconds]);

  function formatLock(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')} Min` : `${s} Sek`;
  }

  function parseErrorMessage(rawMessage, fallback) {
    if (!rawMessage) return fallback;
    try {
      const parsed = JSON.parse(rawMessage);
      if (parsed?.error) return parsed.error;
    } catch {
      // keep raw message
    }
    return rawMessage;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    setLoading(true);
    try {
      const data = await login(username, password);
      setAttemptsLeft(null);
      setLockSeconds(0);
      if (data?.zweiterFaktor) {
        setSchritt(data.zweiterFaktor);
        setPassword('');
        return;
      }
      await weiter();
    } catch (err) {
      fehlerAnzeigen(err, 'Falscher Benutzername oder Passwort');
    } finally {
      setLoading(false);
    }
  };

  // Vor der Anmeldung geteilte Dateien (Share-Target) warten im Cache des
  // Service-Workers – dann direkt zum Fotoimport bzw. zur Jobs-Ansicht, die
  // sie abholen. Der Fotoimport reicht wartende PDFs danach weiter.
  async function weiter() {
    if (await hatGeteilteFotos()) navigate('/foto-import');
    else navigate((await hatGeteilteDateien()) ? '/logs?geteilt=1' : '/');
  }

  async function fertig(data) {
    await anmeldungUebernehmen(data);
    await weiter();
  }

  function zurueckZumPasswort(meldung = '') {
    setSchritt(null);
    setCode('');
    setWiederherstellung(false);
    setAttemptsLeft(null);
    setError(meldung);
  }

  function fehlerAnzeigen(err, fallback) {
    // 429 = Sperre; retryAfterSec startet den Countdown. 401 liefert
    // verbleibendeVersuche erst, wenn es knapp wird (Server entscheidet).
    if (err?.status === 429) {
      setAttemptsLeft(0);
      setLockSeconds(Number(err?.payload?.retryAfterSec) || 60);
    } else {
      const left = err?.payload?.verbleibendeVersuche;
      setAttemptsLeft(typeof left === 'number' ? left : null);
    }
    setError(parseErrorMessage(err?.message, fallback));
  }

  const handleCode = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.auth.zweiterFaktor(code);
      if (typeof data.verbleibendeCodes === 'number') {
        // Wiederherstellungscode verbraucht: kurz sagen, wie viele noch bleiben.
        setHinweis(data.verbleibendeCodes === 0
          ? 'Das war der letzte Wiederherstellungscode. Bitte unter Einstellungen → Persönlich neue erzeugen.'
          : `Noch ${data.verbleibendeCodes} Wiederherstellungscodes übrig.`);
        setAbschluss(data);
        return;
      }
      await fertig(data);
    } catch (err) {
      if (err?.payload?.neuAnmelden) return zurueckZumPasswort(parseErrorMessage(err?.message, 'Bitte erneut anmelden.'));
      setCode('');
      fehlerAnzeigen(err, 'Der Code stimmt nicht.');
    } finally {
      setLoading(false);
    }
  };

  const einrichtungFehler = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err?.payload?.neuAnmelden) zurueckZumPasswort(parseErrorMessage(err?.message, 'Bitte erneut anmelden.'));
      throw err;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      {/* Subtle decorative gradient orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-accent/10 blur-3xl" />
      </div>

      <Card className="w-full max-w-sm relative shadow-xl shadow-primary/5 border-border/60">
        <CardHeader className="text-center pb-2">
          {/* Logo with glow */}
          <div className="relative mx-auto mb-3 flex items-center justify-center" style={{ width: 193, height: 193 }}>
            {/* Blurred glow copy */}
            <img
              src="/logo.svg"
              alt=""
              aria-hidden
              width={193}
              height={193}
              className="absolute inset-0"
              style={{ filter: 'blur(20px)', opacity: 0.65 }}
            />
            {/* Sharp logo on top */}
            <img
              src="/logo.svg"
              alt="postbuch."
              width={193}
              height={193}
              className="relative"
            />
          </div>

          {/* "postbuch." with glow */}
          <CardTitle className="text-xl font-bold">
            <span className="relative inline-block">
              {/* Blur layer – same gradient so teal spreads right-ward correctly */}
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  background: 'linear-gradient(90deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  filter: 'blur(8px)',
                  opacity: 0.85,
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              >
                postbuch<span style={{ fontSize: '1.8em', lineHeight: 1 }}>.</span><span style={{ fontSize: '0.47em', lineHeight: 1 }}>net</span>
              </span>
              {/* Sharp gradient text */}
              <span
                style={{
                  background: 'linear-gradient(135deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  position: 'relative',
                  whiteSpace: 'nowrap',
                }}
              >
                postbuch<span style={{ fontSize: '1.8em', lineHeight: 1 }}>.</span><span style={{ fontSize: '0.47em', lineHeight: 1 }}>net</span>
              </span>
            </span>
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Anmelden bei {instanceName || 'postbuch.net'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {abschluss ? (
            <div className="space-y-3">
              <p className="text-sm">{hinweis}</p>
              <Button className="w-full h-10 btn-gradient text-white font-semibold" onClick={() => fertig(abschluss)}>Weiter</Button>
            </div>
          ) : schritt === 'codes' && neueCodes ? (
            <Wiederherstellungscodes codes={neueCodes.wiederherstellungscodes} weiterText="Weiter" onWeiter={() => fertig(neueCodes)} />
          ) : schritt === 'einrichtung' ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">Für diese Instanz ist die Zwei-Faktor-Anmeldung vorgeschrieben. Bitte jetzt einrichten.</p>
              <ZweiterFaktorEinrichtung
                starten={einrichtungFehler(() => api.auth.loginEinrichten())}
                bestaetigen={einrichtungFehler((c) => api.auth.loginBestaetigen(c))}
                onFertig={(data) => { setNeueCodes(data); setSchritt('codes'); }}
                onAbbrechen={() => zurueckZumPasswort()}
              />
            </div>
          ) : schritt === 'code' ? (
            <form onSubmit={handleCode} className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {wiederherstellung
                  ? 'Einen der gesicherten Wiederherstellungscodes eingeben.'
                  : 'Den 6-stelligen Code aus der Authenticator-App eingeben.'}
              </p>
              <CodeFeld value={code} onChange={setCode} wiederherstellung={wiederherstellung} />
              {error && <p className="text-sm text-destructive font-medium">{error}</p>}
              {lockSeconds > 0 ? (
                <p className="text-sm text-destructive">Erneut möglich in {formatLock(lockSeconds)}.</p>
              ) : attemptsLeft != null && (
                <p className="text-sm text-destructive">
                  {attemptsLeft === 1 ? 'Noch 1 Versuch.' : `Noch ${attemptsLeft} Versuche.`}
                </p>
              )}
              <Button type="submit" className="w-full h-10 btn-gradient text-white font-semibold" disabled={loading || lockSeconds > 0 || !code.trim()}>
                {loading ? 'Prüfe…' : 'Anmelden'}
              </Button>
              <div className="pt-1 flex justify-between text-xs">
                <button type="button" className="text-muted-foreground hover:text-foreground underline underline-offset-2" onClick={() => zurueckZumPasswort()}>
                  Zurück
                </button>
                <button type="button" className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                  onClick={() => { setWiederherstellung((w) => !w); setCode(''); setError(''); }}>
                  {wiederherstellung ? 'Code aus der App verwenden' : 'Wiederherstellungscode verwenden'}
                </button>
              </div>
            </form>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <Input
              type="text"
              placeholder="Benutzername"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              className="h-10"
            />

            <Input
              type="password"
              placeholder="Passwort"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10"
            />

            {error && (
              <p className="text-sm text-destructive font-medium">{error}</p>
            )}
            {lockSeconds > 0 ? (
              <p className="text-sm text-destructive">
                Erneut möglich in {formatLock(lockSeconds)}.
              </p>
            ) : attemptsLeft != null && (
              <p className="text-sm text-destructive">
                {attemptsLeft === 1 ? 'Noch 1 Versuch.' : `Noch ${attemptsLeft} Versuche.`}
              </p>
            )}
            <Button
              type="submit"
              className="w-full h-10 btn-gradient text-white font-semibold"
              disabled={loading || lockSeconds > 0 || !username || !password}
            >
              {loading ? 'Anmelden...' : 'Anmelden'}
            </Button>

            <div className="pt-1 flex justify-center text-xs">
              <button
                type="button"
                onClick={() => {
                  setForgotOpen((v) => !v);
                  setError('');
                }}
                className="whitespace-nowrap text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Passwort vergessen?
              </button>
            </div>

            {forgotOpen && (
              <div className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Nutzer-Passwörter können nur vom Admin zurückgesetzt werden. Der Admin-Benutzername ist immer <strong>admin</strong>. Das Admin-Passwort wurde beim Setup vergeben und steht in der <strong>.env</strong> (Serverzugriff vorausgesetzt).
              </div>
            )}
          </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
