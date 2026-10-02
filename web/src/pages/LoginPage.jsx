import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState(null); // null = kein Hinweis nötig
  const [lockSeconds, setLockSeconds] = useState(0);       // > 0 = gesperrt, Countdown läuft
  const { login } = useAuth();
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
      await login(username, password);
      setAttemptsLeft(null);
      setLockSeconds(0);
      navigate('/');
    } catch (err) {
      // 429 = Sperre; retryAfterSec startet den Countdown. 401 liefert
      // verbleibendeVersuche erst, wenn es knapp wird (Server entscheidet).
      if (err?.status === 429) {
        setAttemptsLeft(0);
        setLockSeconds(Number(err?.payload?.retryAfterSec) || 60);
      } else {
        const left = err?.payload?.verbleibendeVersuche;
        setAttemptsLeft(typeof left === 'number' ? left : null);
      }
      setError(parseErrorMessage(err?.message, 'Falscher Benutzername oder Passwort'));
    } finally {
      setLoading(false);
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
        </CardContent>
      </Card>
    </div>
  );
}
