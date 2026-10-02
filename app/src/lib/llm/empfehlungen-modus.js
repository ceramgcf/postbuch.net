/**
 * Umschaltpunkt fuer den spaeteren Rueckweg zu einem Online-Feed.
 *
 * Solange dieser Wert `false` ist, stammen Modellempfehlungen ausschliesslich
 * aus der mit dem installierten Postbuch-Release ausgelieferten JSON-Datei.
 * Abo, periodischer Abruf und automatische Uebernahme bleiben im Code
 * erhalten, sind aber funktional deaktiviert.
 */
export const ONLINE_EMPFEHLUNGEN_AKTIV = false;

// Alte Abo-Werte duerfen bei einer spaeteren Reaktivierung nicht unbemerkt
// wieder anspringen. Erst ein neues ausdrueckliches Abonnieren schreibt diese
// Generation und macht den Online-Pfad dann wieder aktiv.
export const ONLINE_EMPFEHLUNGEN_ABO_GENERATION = 2;
