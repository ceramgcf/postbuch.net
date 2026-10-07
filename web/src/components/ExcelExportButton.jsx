import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileSpreadsheet, Loader2 } from 'lucide-react';

/**
 * Knopf für einen Excel-Download. `onExport` liefert ein Promise (z. B.
 * api.analyse.handwerkerExport(filter)); Fehler erscheinen unter dem Knopf.
 */
export function ExcelExportButton({ onExport, disabled, title = 'Die angezeigte Auswahl als Excel-Datei herunterladen' }) {
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState(null);

  const exportieren = async () => {
    setLaeuft(true);
    setFehler(null);
    try {
      await onExport();
    } catch (err) {
      setFehler(err.message || 'Export fehlgeschlagen');
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={exportieren} disabled={disabled || laeuft} title={title}>
        {laeuft ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
        Excel
      </Button>
      {fehler && <p className="text-xs text-destructive">{fehler}</p>}
    </div>
  );
}
