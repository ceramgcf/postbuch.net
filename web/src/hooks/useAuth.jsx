import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(null); // null = loading
  const [username, setUsername] = useState(null);
  const [role, setRole] = useState(null);
  const [lesebereich, setLesebereich] = useState('alle');

  useEffect(() => {
    api.auth.check()
      .then((data) => {
        setAuthenticated(true);
        setUsername(data.username ?? null);
        setRole(data.role ?? null);
        setLesebereich(data.lesebereich ?? 'alle');
      })
      .catch(() => {
        setAuthenticated(false);
        setUsername(null);
        setRole(null);
        setLesebereich('alle');
      });
  }, []);

  const login = useCallback(async (username, password) => {
    const data = await api.auth.login(username, password);
    // Der Lesebereich steht nur in /auth/check. Er muss vor dem ersten Rendern
    // der App feststehen, sonst starten die globalen Abfragen der vollen Oberfläche.
    const check = data.role === 'lesezugriff' ? await api.auth.check().catch(() => null) : null;
    setLesebereich(check ? (check.lesebereich ?? 'alle') : (data.role === 'lesezugriff' ? 'eigene' : 'alle'));
    setAuthenticated(true);
    setUsername(data.username ?? null);
    setRole(data.role ?? null);
  }, []);

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
    <AuthContext.Provider value={{ authenticated, username, role, canWrite, isAdmin, istEingeschraenkt, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
