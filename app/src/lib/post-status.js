/**
 * lib/post-status.js — die vergebbaren Dokument-Status
 *
 * Das Postgres-Enum `postbuch.post_status` enthält zusätzlich den stillgelegten
 * Wert 'WaitingForAIReview' (Frühzeit des Projekts, wurde von keiner Stelle mehr
 * vergeben). Enum-Werte lassen sich in Postgres nicht entfernen, ohne den Typ
 * neu zu bauen — deshalb bleibt er in der Datenbank stehen und diese Liste ist
 * die engere, verbindliche Wahrheit für alles, was Status setzt oder annimmt.
 */

export const POST_STATUS = ['AIClearance', 'UserClearance', 'NeedsUserReview'];

export function istGueltigerStatus(wert) {
  return POST_STATUS.includes(wert);
}
