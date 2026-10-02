const MS_PRO_TAG = 24 * 60 * 60 * 1000;
const ZEITZONE = 'Europe/Berlin';

const datumsteileFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: ZEITZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function lokaleDatumsteile(datum) {
  const teile = Object.fromEntries(
    datumsteileFormat.formatToParts(datum)
      .filter(teil => teil.type !== 'literal')
      .map(teil => [teil.type, Number(teil.value)])
  );
  return { jahr: teile.year, monat: teile.month, tag: teile.day };
}

function tagesnummer(datum) {
  const { jahr, monat, tag } = lokaleDatumsteile(datum);
  return Date.UTC(jahr, monat - 1, tag) / MS_PRO_TAG;
}

function isoWochenSchluessel(datum) {
  const { jahr, monat, tag } = lokaleDatumsteile(datum);
  const utcDatum = new Date(Date.UTC(jahr, monat - 1, tag));
  const wochentag = utcDatum.getUTCDay() || 7;
  utcDatum.setUTCDate(utcDatum.getUTCDate() + 4 - wochentag);
  const isoJahr = utcDatum.getUTCFullYear();
  const jahresanfang = new Date(Date.UTC(isoJahr, 0, 1));
  const kalenderwoche = Math.ceil((((utcDatum - jahresanfang) / MS_PRO_TAG) + 1) / 7);
  return `${isoJahr}-W${String(kalenderwoche).padStart(2, '0')}`;
}

function monatsSchluessel(datum) {
  const { jahr, monat } = lokaleDatumsteile(datum);
  return `${jahr}-${String(monat).padStart(2, '0')}`;
}

function halbjahresSchluessel(datum) {
  const { jahr, monat } = lokaleDatumsteile(datum);
  return `${jahr}-H${monat <= 6 ? 1 : 2}`;
}

function datumAusDateiname(dateiname) {
  const match = /^postbuch_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:_|\.pgdump\.gz$)/.exec(dateiname ?? '');
  if (!match) return null;

  const [, jahr, monat, tag, stunde, minute, sekunde, millisekunde] = match.map(Number);
  const datum = new Date(Date.UTC(jahr, monat - 1, tag, stunde, minute, sekunde, millisekunde));
  if (
    datum.getUTCFullYear() !== jahr
    || datum.getUTCMonth() !== monat - 1
    || datum.getUTCDate() !== tag
    || datum.getUTCHours() !== stunde
    || datum.getUTCMinutes() !== minute
    || datum.getUTCSeconds() !== sekunde
    || datum.getUTCMilliseconds() !== millisekunde
  ) {
    return null;
  }
  return datum;
}

/**
 * Der im Dateinamen festgehaltene Laufzeitpunkt ist kanonisch. Storage-Metadaten
 * dienen nur als Fallback, weil Kopieren oder Migrieren deren Erstellzeit ändern kann.
 */
export function backupDatum(datei) {
  const ausName = datumAusDateiname(datei.name);
  if (ausName) return ausName;

  const rohwert = datei.createdDateTime || datei.createdAt || null;
  if (!rohwert) return null;
  const datum = new Date(rohwert);
  return Number.isNaN(datum.getTime()) ? null : datum;
}

function repraesentantSetzen(bucket, schluessel, datei, datum) {
  const vorhanden = bucket.get(schluessel);
  if (!vorhanden || datum > vorhanden.datum) {
    bucket.set(schluessel, { datei, datum });
  }
}

/**
 * Bestimmt die zu behaltenden binären Backups über disjunkte, stabile Buckets:
 * 0–6 Tage vollständig, 7–30 Tage je ISO-Kalenderwoche, 31–365 Tage je
 * Kalendermonat und danach je Kalenderhalbjahr ohne zeitliches Ende. In den
 * verdichteten Buckets bleibt jeweils der neueste vorhandene Stand erhalten.
 * Unklassifizierbare und zukünftige Dateien werden aus Sicherheitsgründen nie
 * automatisch gelöscht.
 */
export function retentionKeepIds(dateien, { jetzt = new Date() } = {}) {
  const keep = new Set();
  const buckets = {
    woche: new Map(),
    monat: new Map(),
    halbjahr: new Map(),
  };
  const heute = tagesnummer(jetzt);

  for (const datei of dateien) {
    const datum = backupDatum(datei);
    if (!datum) {
      keep.add(datei.id);
      continue;
    }

    const alterInTagen = heute - tagesnummer(datum);
    if (alterInTagen < 0) {
      keep.add(datei.id);
    } else if (alterInTagen <= 6) {
      keep.add(datei.id);
    } else if (alterInTagen <= 30) {
      repraesentantSetzen(buckets.woche, isoWochenSchluessel(datum), datei, datum);
    } else if (alterInTagen <= 365) {
      repraesentantSetzen(buckets.monat, monatsSchluessel(datum), datei, datum);
    } else {
      repraesentantSetzen(buckets.halbjahr, halbjahresSchluessel(datum), datei, datum);
    }
  }

  for (const bucket of Object.values(buckets)) {
    for (const { datei } of bucket.values()) keep.add(datei.id);
  }
  return keep;
}
