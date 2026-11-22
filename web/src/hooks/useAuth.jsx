import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(null); // null = loading
  const [username, setUsername] = useState(null);
  const [role, setRole] = useState(null);
  const [lesebereich, setLesebereich] = useState('alle');

  // Nur ein echtes 401 heißt „nicht angemeldet“. Während eines Neustarts der App
  // (Neu-Build, Update) antwortet der Proxy mit 502/503 oder die Verbindung
  // bricht ab; die Sitzung liegt dann weiter gültig in der Datenbank. In dem Fall
  // bleibt die Oberfläche beim Ladezustand und fragt erneut, statt abzumelden.
  useEffect(() => {
    let abgebrochen = false;
    let timer = null;
    let versuch = 0;
    const pruefe = () => {
      api.auth.check()
        .then((data) => {
          if (abgebrochen) return;
          setAuthenticated(true);
          setUsername(data.username ?? null);
          setRole(data.role ?? null);
          setLesebereich(data.lesebereich ?? 'alle');
        })
        .catch((err) => {
          if (abgebrochen) return;
          if (err?.status === 401) {
            setAuthenticated(false);
            setUsername(null);
            setRole(null);
            setLesebereich('alle');
            return;
          }
          versuch += 1;
          timer = setTimeout(pruefe, Math.min(1000 * versuch, 5000));
        });
    };
    pruefe();
    return () => { abgebrochen = true; clearTimeout(timer); };
  }, []);

  // Übernimmt eine abgeschlossene Anmeldung (Passwort allein oder nach dem
  // zweiten Faktor) in den Kontext.
  const anmeldungUebernehmen = useCallback(async (data) => {
    // Der Lesebereich steht nur in /auth/check. Er muss vor dem ersten Rendern
    // der App feststehen, sonst starten die globalen Abfragen der vollen Oberfläche.
    const check = data.role === 'lesezugriff' ? await api.auth.check().catch(() => null) : null;
    setLesebereich(check ? (check.lesebereich ?? 'alle') : (data.role === 'lesezugriff' ? 'eigene' : 'alle'));
    setAuthenticated(true);
    setUsername(data.username ?? null);
    setRole(data.role ?? null);
  }, []);

  /** Liefert die Antwort; bei `zweiterFaktor` ist die Anmeldung noch nicht fertig. */
  const login = useCallback(async (username, password) => {
    const data = await api.auth.login(username, password);
    if (!data.zweiterFaktor) await anmeldungUebernehmen(data);
    return data;
  }, [anmeldungUebernehmen]);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setAuthenticated(false);
    setUsername(null);
    setRole(null);
    setLesebereich('alle');
  }, []);

  /** True for admin and vollzugriff – may perform write operations. */
  const canWrite = role === 'admin' || role === 'vollzugriff';
  /** True only for the admin – may manage users. */
  const isAdmin = role === 'admin';
  /** Lesezugriff nur auf eigene Dokumente – reduzierte Oberfläche. */
  const istEingeschraenkt = role === 'lesezugriff' && lesebereich !== 'alle';

  return (
    <AuthContext.Provider value={{ authenticated, username, role, canWrite, isAdmin, istEingeschraenkt, login, anmeldungUebernehmen, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
