import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/hooks/useAuth';
import { TaskProvider } from '@/hooks/useTaskStore';
import { UndoHistoryProvider } from '@/hooks/useUndoHistory';
import { AbrechnungLauncherProvider } from '@/hooks/useAbrechnungLauncher';
import { PortraitAllowedProvider } from '@/hooks/usePortraitAllowed';
import { PrinterProvider } from '@/contexts/PrinterContext';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TaskProvider>
          <UndoHistoryProvider>
            <AbrechnungLauncherProvider>
              <PortraitAllowedProvider>
                <PrinterProvider>
                  <App />
                </PrinterProvider>
              </PortraitAllowedProvider>
            </AbrechnungLauncherProvider>
          </UndoHistoryProvider>
        </TaskProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Register service worker (PWA installability + Web Push).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then((reg) => {
        // eslint-disable-next-line no-console
        console.log('ServiceWorker registered with scope:', reg.scope);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('ServiceWorker registration failed:', err);
      });
  });

  // SW_NAVIGATE: Push-Benachrichtigung-Klick navigiert ein bereits offenes Fenster.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'SW_NAVIGATE' && event.data?.url) {
      // React Router navigate via window.location so it works regardless of router state.
      window.location.href = event.data.url;
    }
  });
}
