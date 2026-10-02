import { useLayoutEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { EINRICHTUNG_GATE_QUERY_KEY } from '@/lib/einrichtung-gate';
import { istSchlankeHilfe } from '@/lib/docs';
import { useAuth } from '@/hooks/useAuth';
import { AppShell } from '@/components/layout/AppShell';
import { Spinner } from '@/components/ui/spinner';
import { Logo } from '@/components/ui/Logo';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import PostbuchListPage from '@/pages/PostbuchListPage';
import DocumentDetailPage from '@/pages/DocumentDetailPage';
import AktenPage from '@/pages/AktenPage';
import AktenListPage from '@/pages/AktenListPage';
import AkteDetailPage from '@/pages/AkteDetailPage';
import OriginaleListPage from '@/pages/OriginaleListPage';
import SearchPage from '@/pages/SearchPage';
import UnbezahltPage from '@/pages/UnbezahltPage';
import KuerzungenPage from '@/pages/KuerzungenPage';
import PeriodenPage from '@/pages/PeriodenPage';
import HandwerkerPage from '@/pages/HandwerkerPage';
import LogsPage from '@/pages/LogsPage';
import SaldenPage from '@/pages/SaldenPage';
import SaldoDetailPage from '@/pages/SaldoDetailPage';
import WiedervorlagenPage from '@/pages/WiedervorlagenPage';
import SettingsPage from '@/pages/SettingsPage';
import ImportPage from '@/pages/ImportPage';
import ImportwegePage from '@/pages/ImportwegePage';
import DecisionPage from '@/pages/DecisionPage';
import AssistantPage from '@/pages/AssistantPage';
import EinrichtungPage from '@/pages/EinrichtungPage';
import AblageUmzugPage from '@/pages/AblageUmzugPage';
import HilfePage from '@/pages/HilfePage';
import ScannerKalibrierungPage from '@/pages/ScannerKalibrierungPage';

// Viewport-Zoom zentral verwaltet. Standard ist die Desktop-Dichte (width=1280,
// gesetzt in index.html) – auf Mobilgeräten wird die ganze App auf 1280px virtuelle
// Breite skaliert. Das macht die kompakte Login-Card winzig. Ausnahme darum nur für
// /login: dort normale Geräte-Breite, sodass der Auth-Dialog in echter Mobil-Grösse
// erscheint (wie bei familienkalender).
function ViewportManager() {
  const location = useLocation();

  useLayoutEffect(() => {
    const vp = document.querySelector('meta[name="viewport"]');
    if (!vp) return;

    const brauchtGeraetebreite = location.pathname === '/login'
      || location.pathname.startsWith('/einrichtung/')
      || location.pathname.startsWith('/ablage-umzug/')
      || location.pathname.startsWith('/scanner-kalibrierung/');
    vp.content = brauchtGeraetebreite
      ? 'width=device-width,initial-scale=1,user-scalable=no'
      : 'width=1280,user-scalable=no';
  }, [location.pathname]);

  return null;
}

// Hilfe ohne App-Navigation: bei offener Einrichtung (übrige Seiten gesperrt)
// und für Tabs, die ein Assistent über schlankeHilfeUrl() geöffnet hat.
function SchlankeHilfe({ einrichtungOffen }) {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <Logo size={30} />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">Hilfe</p>
          <p className="text-[11px] text-muted-foreground leading-tight">
            {einrichtungOffen ? 'postbuch.net wird noch eingerichtet' : `postbuch.net · v${__APP_VERSION__}`}
          </p>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function EinrichtungsGate({ children }) {
  const { authenticated, isAdmin } = useAuth();
  const location = useLocation();
  const hilfePfad = location.pathname === '/hilfe' || location.pathname.startsWith('/hilfe/');
  const { data, isLoading, isError } = useQuery({
    queryKey: EINRICHTUNG_GATE_QUERY_KEY,
    queryFn: () => api.settingsPublic.einrichtungGate(),
    enabled: authenticated === true && !location.pathname.startsWith('/einrichtung/'),
    retry: false,
    staleTime: 5_000,
  });
  if (authenticated === true && isLoading) {
    return <div className="flex items-center justify-center h-screen"><Spinner className="h-8 w-8" /></div>;
  }
  if (authenticated === true && isError) {
    return (
      <div className="min-h-screen grid place-items-center bg-muted/30 p-6">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">Einrichtungsstatus nicht erreichbar</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Die Oberfläche bleibt geschlossen, bis postbuch.net den Einrichtungszustand sicher prüfen kann. Bitte lade die Seite erneut.
          </p>
        </div>
      </div>
    );
  }
  if (data?.blockiert) {
    // Die Hilfe bleibt auch bei offener Einrichtung erreichbar – der Assistent
    // verweist selbst auf ihre Kapitel.
    if (hilfePfad) return <SchlankeHilfe einrichtungOffen />;
    if (isAdmin) return <Navigate to="/einrichtung/willkommen" replace state={{ from: location.pathname }} />;
    return (
      <div className="min-h-screen grid place-items-center bg-muted/30 p-6">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">postbuch.net wird noch eingerichtet</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Eine administrierende Person muss die Ersteinrichtung abschließen. Danach ist die Oberfläche für dich verfügbar.
          </p>
        </div>
      </div>
    );
  }
  if (hilfePfad && istSchlankeHilfe(location.search)) return <SchlankeHilfe />;
  return children;
}

function ProtectedRoute({ children }) {
  const { authenticated } = useAuth();
  if (authenticated === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (!authenticated) return <Navigate to="/login" replace />;
  return children;
}

// Nur eigene Dokumente: Dokumentliste, Dokumentdetail, Suche, Hilfe und das
// eigene Konto. Alles andere leitet auf die Dokumentliste um; der Server
// sperrt diese Bereiche für das Konto ohnehin.
const EINGESCHRAENKT_PFADE = [/^\/postbuch(\/[^/]+)?\/?$/, /^\/search\/?$/, /^\/hilfe(\/.*)?$/, /^\/einstellungen\/?$/];

function LesebereichGate({ children }) {
  const { istEingeschraenkt } = useAuth();
  const location = useLocation();
  if (istEingeschraenkt && !EINGESCHRAENKT_PFADE.some((re) => re.test(location.pathname))) {
    return <Navigate to="/postbuch" replace />;
  }
  return children;
}

function AdminRoute({ children }) {
  const { authenticated, isAdmin } = useAuth();
  if (authenticated === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (!authenticated) return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { authenticated } = useAuth();

  return (
    <BrowserRouter>
      <ViewportManager />
      <Routes>
        <Route path="/login" element={
          authenticated ? <Navigate to="/" replace /> : <LoginPage />
        } />
        <Route path="/" element={
          <ProtectedRoute>
            <EinrichtungsGate><LesebereichGate><AppShell /></LesebereichGate></EinrichtungsGate>
          </ProtectedRoute>
        }>
          <Route index element={<DashboardPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="importwege" element={<ImportwegePage />} />
          <Route path="postbuch" element={<PostbuchListPage />} />
          <Route path="postbuch/:postid" element={<DocumentDetailPage />} />
          <Route path="akten" element={<AktenPage />}>
            <Route index element={<Navigate to="elektronisch" replace />} />
            <Route path="elektronisch" element={<AktenListPage />} />
            <Route path="originale" element={<OriginaleListPage />} />
          </Route>
          <Route path="akten/:akteid" element={<AkteDetailPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="assistent" element={<AssistantPage />} />
          <Route path="analyse/unbezahlt" element={<UnbezahltPage />} />
          <Route path="analyse/kuerzungen" element={<KuerzungenPage />} />
          <Route path="analyse/perioden" element={<PeriodenPage />} />
          <Route path="analyse/handwerker" element={<HandwerkerPage />} />
          <Route path="analyse/salden" element={<SaldenPage />} />
          <Route path="analyse/salden/:id" element={<SaldoDetailPage />} />
          <Route path="analyse/wiedervorlagen" element={<WiedervorlagenPage />} />
          <Route path="logs" element={<LogsPage />} />
          {/* Anwenderdokumentation aus docs/ – kommt aus der eigenen Instanz,
              braucht kein Internet. */}
          <Route path="hilfe" element={<HilfePage />} />
          <Route path="hilfe/:kapitel" element={<HilfePage />} />
          <Route path="nutzerverwaltung" element={<Navigate to="/einstellungen?tab=menschen" replace />} />
          <Route path="einstellungen" element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          } />
          <Route path="backup" element={<Navigate to="/einstellungen?tab=backup" replace />} />
        </Route>
        <Route path="entscheidung/:jobId" element={<DecisionPage />} />
        <Route path="einrichtung/:schritt" element={
          <AdminRoute><EinrichtungPage /></AdminRoute>
        } />
        <Route path="ablage-umzug/:schritt" element={
          <AdminRoute><AblageUmzugPage /></AdminRoute>
        } />
        <Route path="scanner-kalibrierung/:schritt" element={
          <AdminRoute><ScannerKalibrierungPage /></AdminRoute>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
