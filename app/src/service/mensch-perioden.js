/**
 * Legt beim Aktivieren eines Kostenträgers die initiale Sammelperiode an.
 *
 * Die kanonische Mensch-API und der Legacy-Personenalias müssen hierbei exakt
 * dasselbe Verhalten haben. Vorhandene oder historische Perioden bleiben
 * unverändert.
 */
export async function ensureMenschCollectingPeriods(executor, {
  kurzname,
  pkv,
  beihilfe,
  pkvSatz = null,
  beihilfeSatz = null,
}) {
  const kandidaten = [
    ['PKV', pkv, pkvSatz],
    ['Beihilfe', beihilfe, beihilfeSatz],
  ];
  for (const [kostentraeger, aktiv, satz] of kandidaten) {
    if (!aktiv) continue;
    await executor(
      `INSERT INTO postbuch.abrechnungsperiode_buch
         (person, kostentraeger, periode, status, satz)
       SELECT $1, $2, 1, 'COLLECTING', $3
        WHERE NOT EXISTS (
          SELECT 1 FROM postbuch.abrechnungsperiode_buch
           WHERE person = $1 AND kostentraeger = $2
        )
       ON CONFLICT (person, kostentraeger, periode) DO NOTHING`,
      [kurzname, kostentraeger, satz],
    );
  }
}
