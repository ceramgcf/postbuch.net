import { createContext, useContext, useState, useCallback } from 'react';

/**
 * Verbindet die Perioden-Page (Abschluss-Buttons in einzelnen Perioden) mit
 * der AbrechnungWizardCard. Die Card abonniert "launchRequest" und startet
 * den Wizard mit der entsprechenden Selection.
 */
const AbrechnungLauncherContext = createContext(null);

export function AbrechnungLauncherProvider({ children }) {
  const [launchRequest, setLaunchRequest] = useState(null);

  const launchWithSelection = useCallback((selection) => {
    setLaunchRequest({ id: Date.now(), selection });
  }, []);

  const consumeLaunch = useCallback(() => {
    setLaunchRequest(null);
  }, []);

  return (
    <AbrechnungLauncherContext.Provider value={{ launchRequest, launchWithSelection, consumeLaunch }}>
      {children}
    </AbrechnungLauncherContext.Provider>
  );
}

export function useAbrechnungLauncher() {
  const ctx = useContext(AbrechnungLauncherContext);
  if (!ctx) throw new Error('useAbrechnungLauncher must be used within AbrechnungLauncherProvider');
  return ctx;
}
