/**
 * lib/stack-dienste.js — Register der Dienste für den Einstellungsreiter „Stack“
 *
 * Eine Stelle für alles, was die Oberfläche über die Docker-Dienste wissen muss:
 * Bezeichnung, Container, ob Kern oder optional, welche Host-Aufträge es gibt,
 * und ein RAM-Richtwert unter Last. Was tatsächlich läuft, meldet der Host-Agent
 * im Heartbeat (`stack`); hier wird beides zusammengeführt.
 *
 * Die Aktionen sind genau die module-Werte, die routes/updates.js annimmt
 * (MODULE_WERTE) – der Guard-Test stack-dienste.test.js hält beides gleich.
 * Caddy wird bewusst nicht hier geschaltet: Abschalten kann aussperren, deshalb
 * bleibt das beim DuckDNS-Ablauf mit Bestätigung (Verweis statt Aktion).
 */

/**
 * RAM-Richtwerte in MiB: beobachteter Bedarf unter Last mit Reserve, keine
 * Grenze. Der Embedding-Dienst (mem_limit 1200 MiB) braucht mit Arctic rund
 * 640, mit Voyage 4 Nano oder EmbeddingGemma 2 rund 960 MiB; die
 * lokale KI nimmt ihren Wert aus der Leistungsstufe des Manifests.
 */
export const STACK_DIENSTE = [
  { id: 'postgres', label: 'Datenbank', container: ['postbuch-postgres'], art: 'kern', ramMiB: 256 },
  { id: 'app', label: 'Anwendung', container: ['postbuch-app'], art: 'kern', ramMiB: 512 },
  { id: 'web', label: 'Oberfläche', container: ['postbuch-web'], art: 'kern', ramMiB: 32 },
  {
    id: 'embedding', label: 'Eingebaute Suche (Embeddings)', container: ['postbuch-embedding'],
    art: 'optional', profil: 'embedding', ramMiB: 960,
    aktionen: ['an', 'aus', 'entfernen'],
  },
  {
    id: 'lokalki', label: 'Lokale KI', container: ['postbuch-llm'],
    art: 'optional', profil: 'lokalki', ramMiB: null,
    aktionen: ['an', 'aus', 'entfernen'],
  },
  {
    id: 'scanner', label: 'Scan-Dienste', container: ['postbuch-scanner', 'postbuch-cleaner'],
    art: 'optional', profil: 'scanner', ramMiB: 832,
    aktionen: ['an', 'aus', 'entfernen'],
  },
  {
    id: 'caddy', label: 'HTTPS (Caddy mit DuckDNS)', container: ['postbuch-caddy'],
    art: 'optional', ramMiB: 64, verweis: 'duckdns',
  },
];

/** Alle module-Werte, die der Stack auslösen kann. */
export function stackModulWerte() {
  return STACK_DIENSTE.flatMap((d) => (d.aktionen || []).map((a) => `${d.profil}:${a}`));
}

const ZUSTAND_RANG = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 };

/**
 * Führt Register und Heartbeat zusammen.
 *
 * @param {object|null} stack       leseAgentStatus().stack
 * @param {object}      [profile]   { embedding, scanner } aus dem Heartbeat (true/false/null)
 * @returns {object[]}
 */
export function stackZusammenfuehren(stack, profile = {}) {
  const dienste = new Map((stack?.dienste || []).map((d) => [d.name, d]));
  const lk = stack?.lokalki || null;
  return STACK_DIENSTE.map((d) => {
    const container = d.container.map((name) => dienste.get(name)).filter(Boolean);
    // Mehrere Container (Scanner + Cleaner): der schlechteste Zustand zählt.
    const schlechtester = container
      .slice()
      .sort((a, b) => (ZUSTAND_RANG[b.zustand] ?? 9) - (ZUSTAND_RANG[a.zustand] ?? 9))[0];
    const health = container.some((c) => c.health === 'unhealthy') ? 'unhealthy'
      : container.some((c) => c.health === 'starting') ? 'starting'
        : container.length && container.every((c) => c.health === 'healthy') ? 'healthy' : 'none';
    const imageBytes = container.reduce((s, c) => s + (c.imageBytes || 0), 0) || null;
    let profilAktiv = null;
    if (d.profil === 'lokalki') profilAktiv = lk ? lk.profilAktiv : null;
    else if (d.profil) profilAktiv = typeof profile[d.profil] === 'boolean' ? profile[d.profil] : null;

    const eintrag = {
      id: d.id,
      label: d.label,
      art: d.art,
      aktionen: d.aktionen || [],
      verweis: d.verweis || null,
      installiert: container.length > 0,
      zustand: schlechtester?.zustand || null,
      health,
      profilAktiv,
      imageBytes,
      ramMiB: d.ramMiB,
    };
    if (d.id === 'lokalki' && lk) {
      eintrag.ramMiB = lk.bedarf?.ramMiB ?? null;
      eintrag.lokalki = {
        stufe: lk.stufe,
        modell: lk.modell,
        bedarf: lk.bedarf,
        vorhandenBytes: lk.vorhandenBytes,
        vollstaendig: lk.vollstaendig,
        // Modell im Release geändert, Dienst läuft noch mit dem alten.
        modellVeraltet: !!(lk.modell && lk.bedarf?.modell && lk.modell !== lk.bedarf.modell),
      };
      eintrag.installiert = eintrag.installiert || lk.vollstaendig;
    }
    return eintrag;
  });
}
