import { Router } from 'express';
import { query } from '../db.js';
import { runChatAgent } from '../service/chat-agent.js';
import { runAkteOp, withTransaction } from '../service/akten-service.js';
import { callLLM, resolveKlassenModell } from '../lib/llm.js';
import { loadDynamicSettings } from '../config.js';

const router = Router();

// Prüft, ob eine Chat-Nachricht zu einer Konversation des Nutzers gehört
// (Admins dürfen auf alle zugreifen). Basis für confirm/undo/discard.
async function messageOwned(messageId, username, isAdmin) {
  const r = await query(
    `SELECT m.id FROM postbuch.chat_messages m
     JOIN postbuch.chat_conversations c ON c.id = m.conversation_id
     WHERE m.id = $1 AND ($2 OR c.username = $3)`,
    [messageId, isAdmin, username],
  );
  return r.rows.length > 0;
}

// Protokolliert die Akten-/Dokument-Aktionen einer Assistenten-Nachricht:
// performedActions (status 'done', mit undo_payload) und pendingActions
// (status 'pending', mit exec_payload). Gibt die eingefügten Zeilen zurück.
async function persistAgentActions(messageId, performed = [], pending = [], writeModeRequest = null) {
  const rows = [];
  let seq = 0;
  for (const a of performed) {
    const r = await query(
      `INSERT INTO postbuch.chat_agent_action (message_id, seq, action_type, status, description, undo_payload)
       VALUES ($1, $2, $3, 'done', $4, $5)
       RETURNING id, message_id, seq, action_type, status, description`,
      [messageId, seq++, a.action_type, a.description, a.undo_payload ? JSON.stringify(a.undo_payload) : null],
    );
    rows.push(r.rows[0]);
  }
  for (const a of pending) {
    const r = await query(
      `INSERT INTO postbuch.chat_agent_action (message_id, seq, action_type, status, description, exec_payload)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING id, message_id, seq, action_type, status, description`,
      [messageId, seq++, a.action_type, a.description, JSON.stringify(a.exec_payload)],
    );
    rows.push(r.rows[0]);
  }
  // Lesemodus: der Assistent hat den Bearbeiten-Modus angefordert. Als leichte
  // 'pending'-Zeile mit action_type 'request_write_mode' persistieren, damit der
  // Aktivieren-Button den done-Refetch und einen Reload übersteht. Trägt KEINE
  // ausführbare/rückgängig-machbare Mutation — confirm/undo überspringen sie.
  if (writeModeRequest) {
    const grund = (writeModeRequest.grund || '').toString().slice(0, 300);
    const r = await query(
      `INSERT INTO postbuch.chat_agent_action (message_id, seq, action_type, status, description, exec_payload)
       VALUES ($1, $2, 'request_write_mode', 'pending', $3, $4)
       RETURNING id, message_id, seq, action_type, status, description`,
      [messageId, seq++, grund ? `Bearbeiten-Modus aktivieren, um: ${grund}` : 'Bearbeiten-Modus aktivieren', JSON.stringify({ grund })],
    );
    rows.push(r.rows[0]);
  }
  return rows;
}

// Max. 1 laufende Chat-Anfrage pro Nutzer — verhindert, dass ein Nutzer beliebig
// viele parallele Agent-Läufe (inkl. Subprozess-Spawns im Abo-Pfad) anstößt.
const activeChatUsers = new Set();

// GET /api/chat/conversations — Liste aller Konversationen des eingeloggten Users
router.get('/conversations', async (req, res) => {
  try {
    const username = req.session.username;
    const r = await query(
      `SELECT c.id, c.title, c.created_at,
              (SELECT content FROM postbuch.chat_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
       FROM postbuch.chat_conversations c
       WHERE c.username = $1
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [username]
    );
    res.json({ conversations: r.rows });
  } catch (err) {
    console.error('[chat] GET /conversations error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/chat/conversations — Neue Konversation anlegen
router.post('/conversations', async (req, res) => {
  try {
    const username = req.session.username;
    const { title } = req.body;
    const r = await query(
      `INSERT INTO postbuch.chat_conversations (username, title) VALUES ($1, $2) RETURNING id, title, created_at`,
      [username, title || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[chat] POST /conversations error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/chat/conversations/:id — Konversation + alle Nachrichten
router.get('/conversations/:id', async (req, res) => {
  try {
    const username = req.session.username;
    const convId   = parseInt(req.params.id, 10);

    const convR = await query(
      `SELECT id, title, created_at FROM postbuch.chat_conversations WHERE id = $1 AND username = $2`,
      [convId, username]
    );
    if (convR.rows.length === 0) return res.status(404).json({ error: 'Konversation nicht gefunden' });

    const msgsR = await query(
      `SELECT id, role, content, sources, cost_usd, research_model, synthesis_model, billing, created_at
       FROM postbuch.chat_messages WHERE conversation_id = $1 ORDER BY created_at`,
      [convId]
    );

    // Assistenten-Aktionen (Akten-Änderungen) je Nachricht anhängen — damit
    // Rückgängig-/Bestätigungs-Status nach Reload erhalten bleibt.
    const msgs = msgsR.rows;
    if (msgs.length > 0) {
      const actR = await query(
        `SELECT id, message_id, seq, action_type, status, description
         FROM postbuch.chat_agent_action
         WHERE message_id = ANY($1::bigint[])
         ORDER BY message_id, seq`,
        [msgs.map(m => m.id)]
      );
      const byMsg = new Map();
      for (const a of actR.rows) {
        if (!byMsg.has(a.message_id)) byMsg.set(a.message_id, []);
        byMsg.get(a.message_id).push(a);
      }
      for (const m of msgs) m.actions = byMsg.get(m.id) || [];
    }

    res.json({ conversation: convR.rows[0], messages: msgs });
  } catch (err) {
    console.error('[chat] GET /conversations/:id error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/chat/conversations/:id — Konversation löschen
router.delete('/conversations/:id', async (req, res) => {
  try {
    const username = req.session.username;
    const isAdmin  = req.session.role === 'admin';
    const convId   = parseInt(req.params.id, 10);

    const check = await query(
      `SELECT username FROM postbuch.chat_conversations WHERE id = $1`,
      [convId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!isAdmin && check.rows[0].username !== username) return res.status(403).json({ error: 'Keine Berechtigung' });

    await query(`DELETE FROM postbuch.chat_conversations WHERE id = $1`, [convId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat] DELETE /conversations/:id error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PATCH /api/chat/conversations/:id/title — Titel umbenennen
router.patch('/conversations/:id/title', async (req, res) => {
  try {
    const username = req.session.username;
    const convId   = parseInt(req.params.id, 10);
    const { title } = req.body;

    const r = await query(
      `UPDATE postbuch.chat_conversations SET title = $1 WHERE id = $2 AND username = $3 RETURNING id, title`,
      [title || null, convId, username]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[chat] PATCH /conversations/:id/title error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/chat/conversations/:id/messages — Nachricht senden (SSE-Stream)
router.post('/conversations/:id/messages', async (req, res) => {
  const username = req.session.username;
  const convId   = parseInt(req.params.id, 10);
  const { message, writeEnabled } = req.body;
  // Standard = reiner Lesemodus: spart Tool-Overhead pro Runde. Der Nutzer schaltet
  // Schreibaktionen pro Chat über das Stift-Symbol ein (writeEnabled === true).
  const writeMode = writeEnabled === true;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Nachricht darf nicht leer sein' });
  }

  // Konversation prüfen
  const convCheck = await query(
    `SELECT id FROM postbuch.chat_conversations WHERE id = $1 AND username = $2`,
    [convId, username]
  );
  if (convCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Konversation nicht gefunden' });
  }

  if (activeChatUsers.has(username)) {
    return res.status(429).json({ error: 'Es läuft bereits eine Chat-Anfrage für diesen Nutzer. Bitte warten.' });
  }
  activeChatUsers.add(username);

  // Bricht der Client die Verbindung ab (Reload, Tab-Wechsel, Netzabbruch),
  // muss der laufende Agent-Lauf sofort abgebrochen und der Nutzer-Lock
  // freigegeben werden — sonst bleibt der Lock bis zum 3-Min-Wall-Clock-Timeout
  // gehalten und jede neue Nachricht des Nutzers läuft in ein 429.
  const abortController = new AbortController();
  let finished = false; // true, sobald der reguläre Abschluss (finally) läuft
  req.on('close', () => {
    if (finished) return;
    abortController.abort();
    activeChatUsers.delete(username);
  });

  // SSE-Header
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event, data) => {
    if (finished || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // User-Nachricht persistieren
  await query(
    `INSERT INTO postbuch.chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
    [convId, message.trim()]
  );

  // Konversationsverlauf für Kontext laden
  const historyR = await query(
    `SELECT role, content FROM postbuch.chat_messages
     WHERE conversation_id = $1 AND role IN ('user','assistant')
     ORDER BY created_at DESC LIMIT 12`,
    [convId]
  );
  const history = historyR.rows.reverse().slice(0, -1); // neueste zuerst, dann umkehren; letztes = aktuelle Frage

  try {
    const result = await runChatAgent(
      message.trim(),
      history,
      username,
      req.session.role,
      writeMode,
      (label) => send('progress', { label }),
      (text)  => send('token', { text }),
      abortController.signal,
      { onThinking: (text) => send('thinking', { text }) },
    );

    // Assistent-Antwort persistieren
    const msgR = await query(
      `INSERT INTO postbuch.chat_messages
         (conversation_id, role, content, sources, cost_usd, research_model, synthesis_model, correlation_id, billing)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        convId,
        result.answer,
        result.sources.length ? JSON.stringify(result.sources) : null,
        result.costUsd ? Math.round(result.costUsd * 1e8) / 1e8 : null,
        result.researchModel,
        result.synthesisModel,
        result.correlationId,
        result.billing,
      ]
    );
    const messageId = msgR.rows[0].id;

    // Akten-/Dokument-Aktionen des Assistenten protokollieren (für Anzeige + Undo).
    const actionRows = await persistAgentActions(messageId, result.performedActions, result.pendingActions, result.writeModeRequest);

    // KI-Titel setzen (nur wenn noch keiner vorhanden — also nur nach der 1. Antwort)
    const titleCheck = await query(
      `SELECT title FROM postbuch.chat_conversations WHERE id = $1`, [convId]
    );
    if (!titleCheck.rows[0]?.title) {
      // Fallback vorab berechnen: greift sowohl bei einer Exception als auch,
      // wenn das Modell technisch erfolgreich, aber mit leerem content antwortet
      // (z. B. Reasoning-Modelle, die ihr maxTokens-Budget im reasoning_content
      // verbrennen, bevor der eigentliche Titel drankommt).
      const fallbackTitle = message.trim().slice(0, 60) + (message.trim().length > 60 ? '…' : '');
      let newTitle = '';
      try {
        // Modell aus den Einstellungen (chat_model_title). Nicht hartcodiert, damit
        // der Titel-Aufruf demselben Provider folgt wie der Rest der Instanz.
        const titleSettings = await loadDynamicSettings();
        const titleModel = resolveKlassenModell('chat_title', titleSettings);
        const titleResult = await callLLM(
          titleModel,
          `Erstelle einen kurzen Gesprächstitel (3–6 Wörter) auf Deutsch für diese Anfrage:\n"${message.trim().slice(0, 300)}"\nNur den Titel ausgeben, keine Anführungszeichen, kein Satzzeichen am Ende.`,
          // 1024 statt vormals 25/200: Reasoning-fähige lokale Modelle (z. B. LM
          // Studio mit aktiviertem "Reasoning") verbrauchen einen Teil des
          // Budgets für den Denkblock, bevor der eigentliche Titel kommt. Ein
          // kompletter <think>-Block wird ohnehin serverseitig herausgefiltert
          // (lib/llm/providers/openai.js) — das Budget muss nur noch für "Denken
          // + Titel" statt nur "Titel" reichen. Diese Anfrage ist kurz und
          // selten (einmal pro Konversation), der Mehrverbrauch ist irrelevant.
          { maxTokens: 1024, system: 'Antworte ausschließlich mit dem Titel, ohne weitere Erklärung.' },
          titleSettings,
          { kategorie: 'chat_title' }
        );
        newTitle = (titleResult.text || '').trim().replace(/^[„"'"»«]|["""'»«]$/g, '').slice(0, 80);
        if (!newTitle) {
          console.warn('[chat] Titel-LLM lieferte leeren content (Reasoning-Budget erschöpft?), nutze Fallback', { convId, model: titleModel.model });
        }
      } catch (err) {
        console.warn('[chat] Titel-Generierung fehlgeschlagen, nutze Fallback:', err.message);
      }
      await query(
        `UPDATE postbuch.chat_conversations SET title = $1 WHERE id = $2`,
        [newTitle || fallbackTitle || 'Neue Unterhaltung', convId]
      ).catch(() => {});
    }

    send('sources', { sources: result.sources });
    if (actionRows.length > 0) send('actions', { message_id: messageId, actions: actionRows });
    send('done', {
      message_id:   messageId,
      cost_usd:     result.costUsd,
      tool_calls:   result.toolCallCount,
      billing:      result.billing,
      research_model: result.researchModel,
    });
  } catch (err) {
    // Hat der Agent vor dem Abbruch/Fehler bereits Änderungen ausgeführt oder
    // vorgemerkt, diese trotzdem an eine (Hinweis-)Assistenten-Nachricht hängen,
    // damit sie sichtbar und rückgängig-fähig bleiben (Reversibilitäts-Prämisse).
    const partialPerformed = err.performedActions || [];
    const partialPending   = err.pendingActions || [];
    if (partialPerformed.length || partialPending.length) {
      try {
        const noteR = await query(
          `INSERT INTO postbuch.chat_messages (conversation_id, role, content)
           VALUES ($1, 'assistant', $2) RETURNING id`,
          [convId, '_(Der Lauf wurde unterbrochen — die folgenden bereits vorgenommenen Änderungen können hier rückgängig gemacht werden.)_'],
        );
        const noteRows = await persistAgentActions(noteR.rows[0].id, partialPerformed, partialPending);
        if (!abortController.signal.aborted) send('actions', { message_id: noteR.rows[0].id, actions: noteRows });
      } catch (e2) {
        console.error('[chat] Persistieren der Teil-Aktionen fehlgeschlagen:', e2);
      }
    }
    // Vom Client-Disconnect ausgelöster Abbruch ist kein echter Fehler — nicht als solcher loggen.
    if (abortController.signal.aborted) {
      console.log('[chat] Anfrage vom Client abgebrochen (Verbindung getrennt)');
    } else {
      console.error('[chat] runChatAgent error:', err);
      send('error', { message: err.message || 'Unbekannter Fehler' });
    }
  } finally {
    finished = true;
    activeChatUsers.delete(username);
    res.end();
  }
});

// Aktionsliste einer Nachricht (für Response nach confirm/undo/discard)
async function fetchActions(messageId) {
  const r = await query(
    `SELECT id, message_id, seq, action_type, status, description
     FROM postbuch.chat_agent_action WHERE message_id = $1 ORDER BY seq`,
    [messageId],
  );
  return r.rows;
}

// POST /api/chat/messages/:id/confirm — destruktive (pending) Aktionen ausführen
router.post('/messages/:id/confirm', async (req, res) => {
  try {
    const messageId = parseInt(req.params.id, 10);
    if (!(await messageOwned(messageId, req.session.username, req.session.role === 'admin'))) {
      return res.status(404).json({ error: 'Nachricht nicht gefunden' });
    }
    const pendR = await query(
      `SELECT id, exec_payload FROM postbuch.chat_agent_action
       WHERE message_id = $1 AND status = 'pending' AND action_type <> 'request_write_mode' ORDER BY seq`,
      [messageId],
    );
    if (pendR.rows.length === 0) {
      return res.status(400).json({ error: 'Keine offenen Aktionen zum Bestätigen' });
    }
    // Alle vorgemerkten Aktionen in EINER Transaktion ausführen; das Ergebnis
    // liefert je Aktion die inverse Operation (undo_payload) für späteres Undo.
    await withTransaction(async (db) => {
      for (const row of pendR.rows) {
        const { undo } = await runAkteOp(row.exec_payload, db);
        await db(
          `UPDATE postbuch.chat_agent_action
           SET status = 'done', undo_payload = $1, exec_payload = NULL WHERE id = $2`,
          [undo ? JSON.stringify(undo) : null, row.id],
        );
      }
    });
    res.json({ actions: await fetchActions(messageId) });
  } catch (err) {
    console.error('[chat] POST /messages/:id/confirm error:', err);
    res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/chat/messages/:id/discard — vorgemerkte (pending) Aktionen verwerfen
router.post('/messages/:id/discard', async (req, res) => {
  try {
    const messageId = parseInt(req.params.id, 10);
    if (!(await messageOwned(messageId, req.session.username, req.session.role === 'admin'))) {
      return res.status(404).json({ error: 'Nachricht nicht gefunden' });
    }
    await query(
      `UPDATE postbuch.chat_agent_action
       SET status = 'undone', exec_payload = NULL WHERE message_id = $1 AND status = 'pending'`,
      [messageId],
    );
    res.json({ actions: await fetchActions(messageId) });
  } catch (err) {
    console.error('[chat] POST /messages/:id/discard error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/chat/messages/:id/undo — ausgeführte (done) Aktionen rückgängig machen
router.post('/messages/:id/undo', async (req, res) => {
  try {
    const messageId = parseInt(req.params.id, 10);
    if (!(await messageOwned(messageId, req.session.username, req.session.role === 'admin'))) {
      return res.status(404).json({ error: 'Nachricht nicht gefunden' });
    }
    const doneR = await query(
      `SELECT id, undo_payload FROM postbuch.chat_agent_action
       WHERE message_id = $1 AND status = 'done' AND undo_payload IS NOT NULL
       ORDER BY seq DESC`,
      [messageId],
    );
    if (doneR.rows.length === 0) {
      return res.status(400).json({ error: 'Nichts rückgängig zu machen' });
    }
    // Inverse Operationen in umgekehrter Reihenfolge, transaktional.
    await withTransaction(async (db) => {
      for (const row of doneR.rows) {
        await runAkteOp(row.undo_payload, db);
        await db(`UPDATE postbuch.chat_agent_action SET status = 'undone' WHERE id = $1`, [row.id]);
      }
    });
    res.json({ actions: await fetchActions(messageId) });
  } catch (err) {
    console.error('[chat] POST /messages/:id/undo error:', err);
    res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

export default router;
