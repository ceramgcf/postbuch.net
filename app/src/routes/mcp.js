/**
 * routes/mcp.js — MCP-Adapter (Model Context Protocol) für externe KI-Agenten
 *
 * Zweiter Auth-/Transport-Adapter vor derselben Logik (kein neuer Service):
 * eingehängt in den bestehenden app-Container unter /api/mcp, VOR dem
 * Session-/CSRF-Gate (Bearer-Auth via middleware/mcp-auth.js).
 *
 * Bewusst NUR ZWEI Tools — die gesamte Orchestrierungs-Intelligenz von Postbuch
 * (großer System-Prompt + getunter Agent-Loop) bleibt hinter der Wand, statt
 * Roh-Tools an einen fremden Client auszuspielen:
 *   - askPostbuch : kapselt runChatAgent (READ-ONLY, writeEnabled=false)
 *   - getDocument : kapselt retrieveDocument (deterministisch, PDF als base64)
 *
 * Transport: stateless request-per-instance (StreamableHTTP, sessionlos, JSON
 * statt SSE). Pro POST eine frische McpServer-/Transport-Instanz, danach
 * verworfen — keine Server-seitige Session, passend zur Bearer-Auth.
 *
 * Read-only per Konstruktion: writeEnabled=false erzwingt intern READ_TOOLS;
 * das Write-Mode-/Bestätigungs-Problem entfällt in v1 komplett.
 */

import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runChatAgent } from '../service/chat-agent.js';
import { retrieveDocument } from '../service/document-retriever.js';

const SERVER_NAME = 'postbuch';
const SERVER_VERSION = '1.0.0';
const POSTID_RE = /^P\d{6}$/;

const INSTRUCTIONS =
  'Dieser Connector beantwortet Fragen zum privaten Dokumentenarchiv des Nutzers (Postbuch). ' +
  'Nutze `askPostbuch` für JEDE Frage zu Dokumenten, Akten, Fristen, Wiedervorlagen oder ' +
  'offenen Rechnungen — ein interner Agent recherchiert und antwortet, du brauchst die ' +
  'internen Konventionen nicht zu kennen. `getDocument` lädt das PDF eines konkreten ' +
  'Dokuments (per postid, z.B. P000123) in den Kontext. Sobald eine Frage die eigene ' +
  'reale Lage des Nutzers berührt — nicht bloßes Weltwissen —, kann die Antwort in ' +
  'seinen Unterlagen liegen; sieh dann zuerst hier nach. Für reines Allgemeinwissen ' +
  'ohne Nutzerbezug rufe die Tools nicht auf.';

const INFO_TEXT =
  'Postbuch ist das private Dokumentenarchiv des Nutzers (Post-/Rechnungs-/Behörden-Eingang, ' +
  'KI-klassifiziert und in Akten organisiert). Dieser MCP-Connector ist READ-ONLY: er kann ' +
  'recherchieren und Dokumente laden, aber nichts ändern. Zwei Werkzeuge: askPostbuch (Frage ' +
  'stellen → Prosa-Antwort + Quellen mit postid) und getDocument (PDF per postid laden).';

// Baut pro Request eine frische, an den Bearer-Prinzipal gebundene MCP-Server-
// Instanz. Der Prinzipal (username/role) stammt aus middleware/mcp-auth.js.
function buildServer(principal, abortSignal) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  // Knappe Info-Resource (die eigentlichen Konventionen liegen hinter askPostbuch).
  server.registerResource(
    'postbuch-info',
    'postbuch://info',
    { title: 'Über diesen Connector', description: 'Kurzbeschreibung des Postbuch-Connectors', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, text: INFO_TEXT }] }),
  );

  // ── askPostbuch — delegiert an den internen Chat-Agenten (read-only) ──
  server.registerTool(
    'askPostbuch',
    {
      title: 'Postbuch fragen',
      description:
        'Beantwortet eine Frage zum privaten Postbuch-Dokumentenarchiv des Nutzers. Zuständig, ' +
        'sobald eine Frage die eigenen, realen Angelegenheiten des Nutzers berührt — seinen ' +
        'dokumentierten Alltag, ganz gleich um welches Sachgebiet es geht. Sobald es nicht um bloßes ' +
        'Weltwissen, sondern um seine konkrete Lage geht, ist die Antwort womöglich hier hinterlegt — ' +
        'dann im Zweifel zuerst hier nachsehen, statt aus Unwissen zu antworten oder nach Uploads zu ' +
        'fragen. Reines Allgemein-/Weltwissen ohne Nutzerbezug gehört nicht hierher. Ein interner ' +
        'Agent durchsucht Dokumente, Akten, Wiedervorlagen und Fälligkeiten und liefert eine fertige ' +
        'Antwort samt Quellen (jede Quelle trägt eine postid bzw. akteid). Für den PDF-Inhalt einer ' +
        'Quelle danach getDocument nutzen.',
      inputSchema: {
        frage: z.string().describe('Die Frage des Nutzers zum Postbuch-Archiv (auf Deutsch).'),
        history: z
          .array(z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string(),
          }))
          .optional()
          .describe('Optional: bisheriger Gesprächsverlauf für Rückbezüge.'),
      },
    },
    async ({ frage, history }) => {
      const noop = () => {};
      const result = await runChatAgent(
        frage,
        history ?? [],
        principal.username,
        principal.role,
        /* writeEnabled */ false,
        noop,   // onProgress (kein Streaming über MCP — enableJsonResponse liefert ohnehin
                // nur eine einzelne JSON-Antwort, Zwischen-Notifications kämen nie live an)
        noop,   // onToken
        abortSignal,
        { viaMcp: true },   // nie Thinking anzeigen — das anfragende Modell denkt bereits selbst
      );
      const quellenText = result.sources?.length
        ? '\n\n---\nQuellen (nutze getDocument mit der jeweiligen postid, um das PDF zu laden):\n' +
          JSON.stringify(result.sources)
        : '';
      return { content: [{ type: 'text', text: (result.answer || '') + quellenText }] };
    },
  );

  // ── getDocument — deterministischer PDF-Abruf (kein NL-Agent im Pfad) ──
  server.registerTool(
    'getDocument',
    {
      title: 'Dokument (PDF) laden',
      description:
        'Lädt das PDF eines Postbuch-Dokuments anhand seiner postid (Format PXXXXXX, z.B. P000123) ' +
        'als base64 in den Kontext. postids stammen aus den Quellen einer askPostbuch-Antwort.',
      inputSchema: {
        postid: z.string().describe('PostID des Dokuments (Format PXXXXXX, z.B. P000123).'),
      },
    },
    async ({ postid }) => {
      if (!POSTID_RE.test(postid)) {
        return { content: [{ type: 'text', text: 'Ungültige postid (erwartet Format PXXXXXX, z.B. P000123).' }], isError: true };
      }
      try {
        const { pdf, filename } = await retrieveDocument(postid);
        const base64 = pdf.toString('base64');
        return {
          content: [
            { type: 'text', text: `${filename} — ${pdf.length} Bytes` },
            {
              type: 'resource',
              resource: {
                uri: `postbuch://document/${postid}`,
                mimeType: 'application/pdf',
                blob: base64,
              },
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Dokument ${postid} konnte nicht geladen werden: ${err.message}` }], isError: true };
      }
    },
  );

  return server;
}

const router = Router();

// Stateless: pro POST eine frische Server-/Transport-Instanz (sessionlos, JSON).
router.post('/', async (req, res) => {
  const principal = req.mcp;
  if (!principal) {
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Nicht authentifiziert' }, id: null });
  }

  // Client-Disconnect bricht eine laufende (evtl. lange) Recherche ab.
  const controller = new AbortController();
  const server = buildServer(principal, controller.signal);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,        // JSON-Antwort statt SSE
  });

  res.on('close', () => {
    controller.abort();
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] Request-Fehler:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// Stateless-Modus kennt keine Server-Streams/Sessions → GET/DELETE nicht erlaubt.
function methodNotAllowed(_req, res) {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
}
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

export default router;
