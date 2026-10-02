// Hilfsfunktionen rund um Erstattungs-Zuordnungen und „symbolische Links".
//
// SymLink-Format (bewusst schlank, ohne Typ-Präfix – der Kontext des Feldes
// disambiguiert, das Backend validiert):
//   Arztrechnung (ganze Rechnung): "P######"
//   Einzelposition (AEP):          "P######-<subid>"

// Arten, die als „Arztrechnung" gelten (identisch zur Backend-Ladelogik).
export const ARZTRECHNUNG_ARTEN = ['arztrechnung', 'laborrechnung', 'rezept', 'hilfsmittelrechnung'];

const POSTID_RE = /^P\d{6}$/;

/** SymLink-Token einer ganzen Rechnung. */
export function rechnungToken(postid) {
  return postid || '';
}

/** SymLink-Token einer Einzelposition. */
export function positionToken(postid, subid) {
  return postid && subid != null ? `${postid}-${subid}` : '';
}

/** Extrahiert aus 'P######' oder 'P######-N' die Postnummer, sonst null. */
export function parsePostidToken(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(P\d{6})(?:-\d+)?$/);
  return m ? m[1] : null;
}

/** Zerlegt ein Positions-Token 'P######-N' → { postid, subid } | (bare 'N') → { postid:null, subid } | null. */
export function parsePositionToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const tok = s.match(/^(P\d{6})-(\d+)$/);
  if (tok) return { postid: tok[1], subid: Number(tok[2]) };
  if (/^\d+$/.test(s)) return { postid: null, subid: Number(s) };
  return null;
}

export function isValidPostid(raw) {
  return POSTID_RE.test(String(raw || '').trim());
}
