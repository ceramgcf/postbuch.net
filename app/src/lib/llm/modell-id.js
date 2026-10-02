/**
 * modell-id.js – wann zwei Modell-IDs dasselbe Modell meinen.
 *
 * Provider listen Modelle oft nur als Snapshot ("claude-haiku-4-5-20251001",
 * "gpt-4o-2024-08-06", Bedrock "…-20251001-v1:0"), gespeichert ist aber
 * mitunter der Alias ohne Suffix ("claude-haiku-4-5"). Beides ist dasselbe
 * Modell. Ein bloßer Präfixvergleich reicht dafür NICHT: "claude-opus-5-5"
 * beginnt mit "claude-opus-5", ist aber ein anderes Modell mit anderem Preis.
 * Als gleich gilt deshalb nur, was sich um ein Datums- oder Versions-Suffix
 * unterscheidet.
 *
 * Gegenstück im Frontend: web/src/lib/modellId.js – beide gleich halten.
 */

const SNAPSHOT_SUFFIX = /^(\d{8}|\d{4}-\d{2}-\d{2}|v\d+(:\d+)?)(-|$)/;

/** true, wenn `snapshot` der Alias `alias` plus Datums-/Versions-Suffix ist. */
export function istSnapshotVon(snapshot, alias) {
  if (!snapshot || !alias || !snapshot.startsWith(alias + '-')) return false;
  return SNAPSHOT_SUFFIX.test(snapshot.slice(alias.length + 1));
}

/** Gleiches Modell: exakt, oder eine ID ist Snapshot der anderen. */
export function gleichesModell(a, b) {
  return a === b || istSnapshotVon(a, b) || istSnapshotVon(b, a);
}
