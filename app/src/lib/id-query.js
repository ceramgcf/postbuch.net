// Erkennung und Normalisierung von Post-/Aktennummern in Suchanfragen.
// Genutzt von den Such-Routen (ID-Lookup-Zweig) und dem Suggest-Endpoint.

// parseIdQuery('p123')   → { kind: 'P', digits: '123', exact: 'P000123', prefix: 'P123' }
// parseIdQuery('#A0004') → { kind: 'A', digits: '0004', exact: 'A000004', prefix: 'A0004' }
// parseIdQuery('1234')   → { kind: null, digits: '1234', exact: null, prefix: '1234' }
// parseIdQuery('Rechnung Meier') → null
//
// Bei kind=null (reine Ziffernfolge) kommen sowohl P- als auch A-Objekte in Frage;
// exactCandidates()/prefixCandidates() liefern dann beide Varianten.
export function parseIdQuery(q) {
  if (!q) return null;
  const trimmed = String(q).trim();

  const m = trimmed.match(/^#?\s*([PpAa])\s*[-.]?\s*(\d{1,6})$/);
  if (m) {
    const kind = m[1].toUpperCase();
    const digits = m[2];
    return { kind, digits, exact: kind + digits.padStart(6, '0'), prefix: kind + digits };
  }

  // Reine Ziffernfolge (3–6 Stellen): Buchstabe unbekannt
  const n = trimmed.match(/^#?\s*(\d{3,6})$/);
  if (n) {
    return { kind: null, digits: n[1], exact: null, prefix: n[1] };
  }

  return null;
}

// Exakte IDs (Ziffern auf 6 Stellen gepaddet) für die angefragte Objektart.
// wanted: 'P' oder 'A' — bei kind-Mismatch leer (z.B. "A123" in der Dokumentsuche).
export function exactCandidates(idq, wanted) {
  if (!idq || (idq.kind && idq.kind !== wanted)) return [];
  return [wanted + idq.digits.padStart(6, '0')];
}

// LIKE-Präfixe (Eingabe wie getippt, z.B. "P123" → P123xxx) für die Objektart.
export function prefixCandidates(idq, wanted) {
  if (!idq || (idq.kind && idq.kind !== wanted)) return [];
  return [wanted + idq.digits];
}
