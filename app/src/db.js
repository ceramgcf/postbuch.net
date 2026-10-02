import pg from 'pg';
const { Pool, types } = pg;

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of Date objects.
// Without this, pg converts DATE → JS Date (UTC midnight), which JSON-serializes to
// e.g. "2024-01-14T23:00:00.000Z" for a stored value of 2024-01-15 in UTC+1.
// That causes the frontend to display/compare dates one day too early.
types.setTypeParser(1082, (val) => val); // OID 1082 = DATE

// postbuch.net ist ausschließlich für den Einsatz in Deutschland gedacht. Die
// Session-Zeitzone jeder DB-Verbindung wird deshalb hart auf Europe/Berlin gesetzt,
// statt auf den bei initdb einmalig eingefrorenen Server-Default zu vertrauen (der
// bei bestehenden Installationen weiterhin UTC sein kann). Ohne das würde
// CURRENT_DATE/now() rund um Mitternacht CEST/UTC einen Tag vom realen Datum
// abweichen. `options` wird als Postgres-Startup-Parameter übertragen (wie
// PGOPTIONS) und greift dadurch race-frei vor der ersten Query jeder Verbindung –
// anders als ein nachgelagertes `client.query('SET ...')` im 'connect'-Event, das
// mit der eigentlich angeforderten Query um dieselbe Verbindung konkurrieren kann.
// Greift nur, wenn DATABASE_URL selbst kein eigenes `options=` mitbringt – die
// von docker-entrypoint.sh gebaute URL tut das (dort steht TimeZone bereits neben
// search_path in derselben Startup-Option); dieses Feld ist der Fallback für ein
// manuell in .env gesetztes DATABASE_URL ohne eigene `options`.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c TimeZone=Europe/Berlin',
});

export const query = (text, params) => pool.query(text, params);

export const getClient = () => pool.connect();

export default pool;
