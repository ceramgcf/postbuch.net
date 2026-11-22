import { effektiveGruppe } from '../lib/taxonomie.js';
import { laeuftErstattungsbescheid } from './document-inserter.js';
import { sperreBescheidzuordnung } from './perioden-sperre.js';

const KOPFFELDER = ['kostentraeger', 'bescheiddatum', 'erstattungsbetrag', 'hinweise'];
const POSITIONSFELDER = ['behandelte_person', 'kostenart', 'bezugsdatum', 'beleg_nr', 'rechnungsbetrag', 'erstattungsbetrag'];
const KOSTENTRAEGER = ['Beihilfe', 'PKV'];

function fehler(status, meldung) {
  return Object.assign(new Error(meldung), { status });
}

function leseFelder(body, erlaubt) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw fehler(400, 'Ungültige Bescheiddaten.');
  }
  const felder = {};
  for (const feld of Object.keys(body)) {
    if (feld === 'stand') continue;
    if (!erlaubt.includes(feld)) throw fehler(400, 'Dieses Feld ist hier nicht bearbeitbar.');
    const roh = body[feld];
    if (roh != null && typeof roh !== 'string' && !(feld.endsWith('betrag') && typeof roh === 'number')) {
      throw fehler(400, 'Ungültiger Feldwert.');
    }
    const wert = roh == null ? '' : String(roh).trim();
    if (wert && feld.endsWith('betrag')) {
      if (!/^[+-]?\d{1,10}(?:[,.]\d{1,2})?$/.test(wert)) {
        throw fehler(400, 'Bitte einen Betrag mit höchstens zwei Nachkommastellen eingeben.');
      }
      felder[feld] = Number(wert.replace(',', '.')).toFixed(2);
    } else if (wert && feld.endsWith('datum')) {
      const datum = new Date(wert + 'T00:00:00Z');
      if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(wert) || !Number.isFinite(datum.getTime())
        || datum.toISOString().slice(0, 10) !== wert) {
        throw fehler(400, 'Bitte ein gültiges Datum eingeben.');
      }
      felder[feld] = wert;
    } else {
      felder[feld] = wert || null;
    }
  }
  return felder;
}

function pruefeStand(zeile, stand) {
  if (zeile.stand !== stand) {
    throw fehler(409, 'Die Daten wurden inzwischen geändert. Bitte die Ansicht neu laden und erneut bearbeiten.');
  }
}

async function sperreBescheid(client, postid) {
  // Dokument zuerst, wie bei Löschung und Wiederverarbeitung. Beide
  // Kostenträger sperren, solange ein Wechsel des Kostenträgers möglich ist.
  const { rows: [doc] } = await client.query(
    `SELECT lebensbereich, COALESCE(dokumentart, art) AS dokumentart
       FROM postbuch.postbuch WHERE postid = $1 FOR NO KEY UPDATE`, [postid],
  );
  if (!doc) throw fehler(404, 'Dokument nicht gefunden.');
  await sperreBescheidzuordnung(client, KOSTENTRAEGER);
  const { rows: [job] } = await client.query(
    `SELECT 1 FROM postbuch._pipeline_file_journal WHERE postid = $1 AND state = 'eb_pending' LIMIT 1`, [postid],
  );
  if (job || laeuftErstattungsbescheid(postid)) {
    throw fehler(409, 'Der Bescheid wird gerade ausgewertet. Bitte warte den Abgleich ab.');
  }
  const { rows: [kopf] } = await client.query(
    `SELECT *, xmin::text AS stand FROM postbuch.erstattungsbescheid WHERE postid = $1 FOR UPDATE`, [postid],
  );
  return { doc, kopf };
}

async function sperreKuerzungen(client, postid, subid) {
  const { rowCount } = await client.query(
    `SELECT kuerzung_id FROM postbuch.erstattungsbescheid_kuerzung
      WHERE postid = $1 AND ($2::int IS NULL OR eb_subid = $2)
      ORDER BY eb_subid, kuerzung_id FOR UPDATE`, [postid, subid],
  );
  return rowCount > 0;
}

async function pruefePruefvormerkung(client, postid, subid = null) {
  // Eine neue Vormerkung nimmt zunächst die Sperre ihrer Kürzungszeile.
  if (!(await sperreKuerzungen(client, postid, subid))) return;
  const { rowCount } = await client.query(
    `SELECT 1 FROM postbuch.beihilfe_kuerzung_pkv_pruefung
      WHERE eb_postid = $1 AND ($2::int IS NULL OR eb_subid = $2) LIMIT 1`, [postid, subid],
  );
  if (rowCount) throw fehler(409, 'Das Feld ist durch eine vorgemerkte oder eingereichte PKV-Prüfung geschützt.');
}

// Nur serverseitig ausgewählte Tabellen und Spalten gelangen ins SQL.
async function aktualisiere(client, tabelle, postid, felder, subid = null) {
  const eintraege = Object.entries(felder);
  if (!eintraege.length) return;
  await client.query(
    `UPDATE postbuch.${tabelle} SET ${eintraege.map(([feld], i) => `${feld} = $${i + 3}`).join(', ')}
      WHERE postid = $1 AND ${subid === null ? '$2::int IS NULL' : 'subid = $2'}`,
    [postid, subid, ...eintraege.map(([, wert]) => wert)],
  );
}

export async function speichereBescheidkopf(client, postid, body, neu) {
  const felder = leseFelder(body, KOPFFELDER);
  const { doc, kopf } = await sperreBescheid(client, postid);
  if (neu && kopf) throw fehler(409, 'Der Bescheid hat bereits Fachdaten. Bitte lade die Ansicht neu.');
  if (!neu && !kopf) throw fehler(404, 'Erstattungsbescheid nicht gefunden.');
  const istTier = kopf?.ist_tier ?? doc.lebensbereich === 'tier';
  const ktWechsel = neu || ('kostentraeger' in felder && felder.kostentraeger !== kopf.kostentraeger);
  if (ktWechsel && (!KOSTENTRAEGER.includes(felder.kostentraeger) || (istTier && felder.kostentraeger !== 'PKV'))) {
    throw fehler(400, istTier ? 'Bei Tierbescheiden ist nur PKV zulässig.' : 'Bitte einen Kostenträger auswählen.');
  }

  if (neu) {
    if (await effektiveGruppe(doc.lebensbereich, doc.dokumentart, client) !== 'erstattungsbescheid') {
      throw fehler(409, 'Das Dokument ist kein Erstattungsbescheid.');
    }
    await client.query(
      `INSERT INTO postbuch.erstattungsbescheid (postid, kostentraeger, bescheiddatum, erstattungsbetrag, hinweise, ist_tier)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [postid, felder.kostentraeger, felder.bescheiddatum ?? null, felder.erstattungsbetrag ?? null, felder.hinweise ?? null, istTier],
    );
    return;
  }

  pruefeStand(kopf, body.stand);
  if (ktWechsel || ('bescheiddatum' in felder && felder.bescheiddatum !== kopf.bescheiddatum)) {
    // Positionen stabil halten, damit keine neue Kürzung zwischen Prüfung und
    // Kopfänderung angelegt werden kann. FOR UPDATE ist zugleich der FK-Lock.
    await client.query(
      'SELECT subid FROM postbuch.erstattungsbescheid_einzelposition WHERE postid = $1 ORDER BY subid FOR UPDATE', [postid],
    );
    await pruefePruefvormerkung(client, postid);
  }
  if (ktWechsel) {
    const { rows: [bezug] } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM postbuch.abrechnungsperiode_buch WHERE eb_postid = $1) AS periode,
              EXISTS (SELECT 1 FROM postbuch.erstattungsbescheid_einzelposition WHERE postid = $1 AND arz_postid IS NOT NULL
                      UNION ALL
                      SELECT 1 FROM postbuch.erstattungsbescheid_kuerzung WHERE postid = $1 AND arz_postid IS NOT NULL) AS rechnung`,
      [postid],
    );
    if (bezug.periode || bezug.rechnung) {
      throw fehler(409, 'Der Kostenträger ist durch Rechnungszuordnungen oder eine Abrechnungsperiode geschützt.');
    }
    felder.kostentraeger_profil_id = null;
    felder.kostentraeger_profil_name = null;
  }
  await aktualisiere(client, 'erstattungsbescheid', postid, felder);
}

async function pruefePerson(client, istTier, person, arzPostid = null) {
  if (person) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM postbuch.mensch WHERE kurzname = $1 AND ist_tier = $2 FOR SHARE', [person, istTier],
    );
    if (!rowCount) throw fehler(400, 'Bitte eine zum Bescheid passende behandelte Person auswählen.');
  }
  if (arzPostid) {
    const { rows: [rechnung] } = await client.query(
      'SELECT behandelte_person FROM postbuch.arztrechnung WHERE postid = $1 FOR SHARE', [arzPostid],
    );
    if (rechnung?.behandelte_person && rechnung.behandelte_person !== person) {
      throw fehler(409, 'Die behandelte Person muss zur zugeordneten Rechnung passen.');
    }
  }
}

export async function bearbeiteBescheidposition(client, postid, subid, body, loeschen = false) {
  const felder = leseFelder(body, loeschen ? [] : POSITIONSFELDER);
  const { kopf } = await sperreBescheid(client, postid);
  if (!kopf) throw fehler(404, 'Erstattungsbescheid nicht gefunden.');

  if (subid === null) {
    if (!Object.values(felder).some((wert) => wert !== null)) throw fehler(400, 'Bitte fülle mindestens ein Positionsfeld aus.');
    await pruefePerson(client, kopf.ist_tier, felder.behandelte_person);
    const { rows: [naechste] } = await client.query(
      `UPDATE postbuch.erstattungsbescheid
          SET letzte_manuelle_positionsnummer = GREATEST(letzte_manuelle_positionsnummer,
                COALESCE((SELECT MAX(subid) FROM postbuch.erstattungsbescheid_einzelposition WHERE postid = $1), 0)) + 1
        WHERE postid = $1 RETURNING letzte_manuelle_positionsnummer AS subid`, [postid],
    );
    const spalten = Object.keys(felder);
    await client.query(
      `INSERT INTO postbuch.erstattungsbescheid_einzelposition (postid, subid, ${spalten.join(', ')})
       VALUES ($1, $2, ${spalten.map((_, i) => `$${i + 3}`).join(', ')})`,
      [postid, naechste.subid, ...Object.values(felder)],
    );
    return { subid: naechste.subid };
  }

  const { rows: [ep] } = await client.query(
    `SELECT *, xmin::text AS stand FROM postbuch.erstattungsbescheid_einzelposition
      WHERE postid = $1 AND subid = $2 FOR UPDATE`, [postid, subid],
  );
  if (!ep) throw fehler(404, 'Bescheidposition nicht gefunden.');
  pruefeStand(ep, body.stand);
  if (loeschen) {
    if (ep.arz_postid) throw fehler(409, 'Bitte zuerst die Rechnungszuordnung dieser Position lösen.');
    if (await sperreKuerzungen(client, postid, subid)) {
      throw fehler(409, 'Bitte zuerst die Kürzungen dieser Position entfernen.');
    }
    await client.query(
      `UPDATE postbuch.erstattungsbescheid SET letzte_manuelle_positionsnummer = $2
        WHERE postid = $1 AND letzte_manuelle_positionsnummer < $2`, [postid, subid],
    );
    await client.query('DELETE FROM postbuch.erstattungsbescheid_einzelposition WHERE postid = $1 AND subid = $2', [postid, subid]);
  } else {
    const personGeaendert = 'behandelte_person' in felder && felder.behandelte_person !== ep.behandelte_person;
    if (personGeaendert || ('beleg_nr' in felder && felder.beleg_nr !== ep.beleg_nr)) {
      await pruefePruefvormerkung(client, postid, subid);
    }
    if (personGeaendert) await pruefePerson(client, kopf.ist_tier, felder.behandelte_person, ep.arz_postid);
    await aktualisiere(client, 'erstattungsbescheid_einzelposition', postid, felder, subid);
  }
  return { arz_postid: ep.arz_postid };
}
