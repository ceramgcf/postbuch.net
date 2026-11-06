import { Bug, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { kameraVerfuegbar } from '@/lib/kamerascan/kamera';
import { useDebugModus } from '@/hooks/useDebugModus';
import { useSeitenstapel } from './Seitenstapel';

// Karte „Mit Kamera scannen“ auf der Importseite. Die Bildverarbeitung läuft
// komplett auf dem Gerät; hochgeladen wird nur die fertige PDF – wie beim
// Datei-Upload in die Pipeline bzw. im Ersatz-Modus als neue Datei des Eintrags.
// Vorhandene Fotos kommen über den Galerie-Knopf im Livebild oder den
// Datei-Upload in denselben Scan.
export default function KameraScanKarte({ replaceForPostId = null, onReplaceComplete }) {
  const debugModus = useDebugModus();
  const stapel = useSeitenstapel();

  if (!kameraVerfuegbar() || !stapel.verfuegbar) return null;

  const oeffnen = (diagnose) => stapel.oeffnen(replaceForPostId
    ? { ersetzen: replaceForPostId, onErsetzt: onReplaceComplete, diagnose }
    : { diagnose });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Camera className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">
            {replaceForPostId ? 'Mit Kamera scannen (Ersatz)' : 'Mit Kamera scannen'}
          </CardTitle>
        </div>
        <CardDescription className="text-xs">
          {replaceForPostId
            ? `Seiten mit der Kamera dieses Geräts aufnehmen oder aus Fotos übernehmen; die fertige PDF ersetzt die Datei von ${replaceForPostId}. Keine Pipeline, keine KI.`
            : 'Ein- oder mehrseitige Dokumente mit der Kamera dieses Geräts aufnehmen oder aus vorhandenen Fotos übernehmen. Rand, Entzerrung und Kontrast erledigt das Gerät selbst, hochgeladen wird nur die fertige PDF.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => oeffnen(false)}>
            <Camera className="h-4 w-4" /> Kamera öffnen
          </Button>
          {/* Nur im Debug-Modus: Kenndaten von Videostrom, Foto und Ausschnittsabgleich */}
          {debugModus && (
            <Button variant="outline" onClick={() => oeffnen(true)}>
              <Bug className="h-4 w-4" /> Kamera-Diagnose
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
