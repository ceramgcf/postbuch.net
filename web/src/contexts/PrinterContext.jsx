import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { connectPrinter, disconnectPrinter, printLabel as sendToPrinter } from '@/lib/niimbotPrinter';

const PrinterContext = createContext(null);

export function PrinterProvider({ children }) {
  const clientRef = useRef(null);
  const [deviceName, setDeviceName] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);

  const connect = useCallback(async () => {
    const { client, deviceName: name } = await connectPrinter();
    clientRef.current = client;
    setDeviceName(name);
    setIsConnected(true);

    client.on('disconnect', () => {
      clientRef.current = null;
      setDeviceName(null);
      setIsConnected(false);
    });
  }, []);

  const disconnect = useCallback(async () => {
    if (clientRef.current) {
      await disconnectPrinter(clientRef.current);
      clientRef.current = null;
      setDeviceName(null);
      setIsConnected(false);
    }
  }, []);

  const print = useCallback(async (canvas) => {
    if (!clientRef.current || !clientRef.current.isConnected()) {
      throw new Error('Kein Drucker verbunden');
    }
    setIsPrinting(true);
    try {
      await sendToPrinter(clientRef.current, canvas);
    } finally {
      setIsPrinting(false);
    }
  }, []);

  return (
    <PrinterContext.Provider value={{ isConnected, deviceName, isPrinting, connect, disconnect, print }}>
      {children}
    </PrinterContext.Provider>
  );
}

export function usePrinter() {
  const ctx = useContext(PrinterContext);
  if (!ctx) throw new Error('usePrinter must be used within PrinterProvider');
  return ctx;
}
