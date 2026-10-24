import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Bug, Camera, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { kameraVerfuegbar } from '@/lib/kamerascan/kamera';
import KameraScan from './KameraScan';
import { useKameraHochladen } from './useKameraHochladen';
import { useDebugModus } from '@/hooks/useDebugModus';
import { etikettPfad } from '@/lib/kamerascan/postbuchQr';

// Karte „Mit Kamera scannen“ auf der Importseite. Die Bildverarbeitung läuft
// komplett auf dem Gerät; hochgeladen wird nur die fertige PDF – wie beim
// Datei-Upload in die Pipeline bzw. im Ersatz-Modus als neue Datei des Eintrags.
export default function KameraScanKarte({ replaceForPostId = null, onReplaceComplete }) {
  const [offen, setOffen] = useState(false);
  const [diagnose, setDiagnose] = useState(false);
  const debugModus = useDebugModus();
  const navigate = useNavigate();
  const [meldung, setMeldung] = useState(null);
  const hochladenNachPipeline = useKameraHochladen({ replaceForPostId, onReplaceComplete });

  if (!kameraVerfuegbar()) return null;

  async function hochladen(scan) {
    const text = await hochladenNachPipeline(scan);
    if (text) setMeldung({ typ: 'erfolg', text });
  }

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
            ? `Seiten mit der Kamera dieses Geräts aufnehmen; die fertige PDF ersetzt die Datei von ${replaceForPostId}. Keine Pipeline, keine KI.`
            : 'Ein- oder mehrseitige Dokumente mit der Kamera dieses Geräts aufnehmen. Rand, Entzerrung und Kontrast erledigt das Gerät selbst, hochgeladen wird nur die fertige PDF.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { setMeldung(null); setDiagnose(false); setOffen(true); }}>
            <Camera className="h-4 w-4" /> Kamera öffnen
          </Button>
          {/* Nur im Debug-Modus: Kenndaten von Videostrom, Foto und Ausschnittsabgleich */}
          {debugModus && (
            <Button variant="outline" onClick={() => { setMeldung(null); setDiagnose(true); setOffen(true); }}>
              <Bug className="h-4 w-4" /> Kamera-Diagnose
            </Button>
          )}
        </div>
        {meldung && (
          <p className={`flex items-center gap-2 text-sm ${meldung.typ === 'erfolg' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}`}>
            {meldung.typ === 'erfolg' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            {meldung.text}
          </p>
        )}
      </CardContent>
      <KameraScan
        offen={offen}
        onSchliessen={() => setOffen(false)}
        onFertig={hochladen}
        zielText={replaceForPostId ? 'Ersetzen' : 'Hochladen'}
        diagnose={diagnose}
        onPostbuchQr={replaceForPostId ? undefined : (kennung) => navigate(etikettPfad(kennung))}
      />
    </Card>
  );
}
