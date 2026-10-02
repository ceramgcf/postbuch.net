/**
 * lib/discord-gateway.js — Discord WebSocket Gateway für Button-Interactions
 *
 * Startet nur wenn discord_bot_token + discord_channel_id konfiguriert sind.
 * Behandelt INTERACTION_CREATE (Button-Klicks) für Duplikat-Entscheidungen.
 *
 * Opcodes: 10 HELLO, 1 HEARTBEAT, 11 HEARTBEAT_ACK, 2 IDENTIFY, 0 DISPATCH
 * Intents: 1 (GUILDS) — ausreichend für Component-Interactions
 *
 * Dep: ws (~70KB, minimale WebSocket-Library)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  // ws nicht installiert — Gateway wird nicht gestartet
  WebSocket = null;
}

import { loadDynamicSettings } from '../config.js';
import { appLog } from '../app-log.js';
import * as discord from './discord.js';

const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const OPCODES = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, HELLO: 10, HEARTBEAT_ACK: 11 };

let _resolveHandler = null; // gesetzt aus index.js via setButtonHandler

/**
 * Registriert den Handler für Button-Interactions.
 * @param {(jobId: string, decision: string, interactionId: string, interactionToken: string, username: string) => Promise<void>} fn
 */
export function setButtonHandler(fn) {
  _resolveHandler = fn;
}

let _ws = null;
let _heartbeatInterval = null;
let _reconnectTimeout = null;
let _reconnectDelay = 1000;
let _running = false;
let _token = null;

/**
 * Startet den Gateway-Listener.
 * Verbindet sich automatisch neu bei Verbindungsabbruch.
 */
export async function start() {
  await syncWithSettings();
}

export async function syncWithSettings() {
  if (!WebSocket) {
    console.warn('[discord-gateway] ws-Package nicht verfügbar — Gateway deaktiviert');
    return false;
  }

  const s = await loadDynamicSettings();
  if (!s.discord_bot_token || !s.discord_channel_id) {
    if (_running || _ws || _reconnectTimeout) {
      console.log('[discord-gateway] Bot-Konfiguration entfernt — Gateway wird gestoppt');
    } else {
      console.log('[discord-gateway] Bot nicht konfiguriert — Gateway nicht gestartet');
    }
    stop();
    return false;
  }

  if (_running && _token === s.discord_bot_token && (_ws || _reconnectTimeout)) {
    return true;
  }

  stop();
  _running = true;
  _token = s.discord_bot_token;
  connect(_token);
  return true;
}

export function stop() {
  _running = false;
  _token = null;
  cleanup();
}

function connect(token) {
  if (!_running) return;

  try {
    _ws = new WebSocket(DISCORD_GATEWAY);

    _ws.on('open', () => {
      console.log('[discord-gateway] WebSocket verbunden');
      _reconnectDelay = 1000;
    });

    _ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleMessage(msg, token);
    });

    _ws.on('error', (err) => {
      console.error('[discord-gateway] WebSocket-Fehler:', err.message);
    });

    _ws.on('close', (code) => {
      console.log(`[discord-gateway] Verbindung geschlossen (code=${code}) — reconnect in ${_reconnectDelay}ms`);
      cleanup();
      if (_running) scheduleReconnect(token);
    });
  } catch (err) {
    console.error('[discord-gateway] connect() fehlgeschlagen:', err.message);
    if (_running) scheduleReconnect(token);
  }
}

function scheduleReconnect(token) {
  _reconnectTimeout = setTimeout(() => {
    _reconnectDelay = Math.min(_reconnectDelay * 2, 60_000);
    connect(token);
  }, _reconnectDelay);
}

function cleanup() {
  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
  if (_reconnectTimeout) { clearTimeout(_reconnectTimeout); _reconnectTimeout = null; }
  if (_ws) {
    try { _ws.terminate(); } catch {}
    _ws = null;
  }
}

function send(data) {
  if (_ws?.readyState === (WebSocket ? WebSocket.OPEN : 1)) {
    _ws.send(JSON.stringify(data));
  }
}

function handleMessage(msg, token) {
  const { op, d, t } = msg;

  if (op === OPCODES.HELLO) {
    // Heartbeat-Intervall starten
    const interval = d?.heartbeat_interval || 41250;
    _heartbeatInterval = setInterval(() => {
      send({ op: OPCODES.HEARTBEAT, d: null });
    }, interval);

    // Identify
    send({
      op: OPCODES.IDENTIFY,
      d: {
        token,
        intents: 1, // GUILDS
        properties: { os: 'linux', browser: 'postbuch', device: 'postbuch' },
      },
    });
    return;
  }

  if (op === OPCODES.HEARTBEAT) {
    send({ op: OPCODES.HEARTBEAT, d: null });
    return;
  }

  if (op === OPCODES.DISPATCH && t === 'INTERACTION_CREATE') {
    handleInteraction(d).catch(err => {
      console.error('[discord-gateway] Interaction-Handler-Fehler:', err.message);
      appLog('ERROR', 'discord-gateway', `Interaction-Handler-Fehler: ${err.message}`);
    });
  }
}

async function handleInteraction(interaction) {
  // Nur Button-Interactions verarbeiten (component_type === 2)
  if (interaction.type !== 3 || interaction.data?.component_type !== 2) return;

  const customId = interaction.data?.custom_id || '';
  const match = customId.match(/^dup:(replace|discard|keep_both):(.+)$/);
  if (!match) return;

  const decision = match[1];
  const jobId = match[2];
  const interactionId = interaction.id;
  const interactionToken = interaction.token;
  const username = interaction.member?.user?.username || interaction.user?.username || 'Unbekannt';

  // ACK sofort: UPDATE_MESSAGE (type 7) — verhindert "Diese Interaktion schlug fehl"
  await ackInteraction(interactionId, interactionToken);

  if (_resolveHandler) {
    await _resolveHandler(jobId, decision, interactionId, interactionToken, username);
  }
}

async function ackInteraction(id, token) {
  try {
    await fetch(`https://discord.com/api/v10/interactions/${id}/${token}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 7, data: { flags: 64 } }), // ephemeral ACK
    });
  } catch (err) {
    console.error('[discord-gateway] ACK fehlgeschlagen:', err.message);
  }
}
