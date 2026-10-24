#!/usr/bin/env node
/**
 * cli/hilfe-vektoren-erzeugen.js — erzeugt app/hilfe-vektoren.json, die mit
 * dem Release ausgelieferten Hilfevektoren des eingebauten Embedding-Dienstes
 * (siehe lib/hilfe-vektoren.js).
 *
 * Zerlegt die im Image liegende Anwenderhilfe genau wie help-corpus.js und
 * bettet jeden Abschnitt direkt beim Dienst ein; Datenbank und Einstellungen
 * der Instanz spielen keine Rolle. Die bisherige Datei kommt über stdin
 * herein, unveränderte Abschnitte behalten ihren Vektor. Ausgabe auf stdout.
 *
 * Aufruf (nach dem Neubau des App-Images mit dem endgültigen docs/-Stand):
 *
 *   docker compose exec -T app node src/cli/hilfe-vektoren-erzeugen.js \
 *     < app/hilfe-vektoren.json > /tmp/hilfe-vektoren.json \
 *     && mv /tmp/hilfe-vektoren.json app/hilfe-vektoren.json
 *
 * EMBEDDING_URL überschreibt die Adresse des Dienstes (Standard wie im Stack).
 */

import { loadHelpSource } from '../service/help-corpus.js';
import { EINGEBAUTES_EMBEDDING, mitVorsilbe, signatureOf } from '../lib/embedding.js';
import { dekodiereVektor, kodiereVektor, vektorDatei } from '../lib/hilfe-vektoren.js';

const URL_DIENST = (process.env.EMBEDDING_URL || 'http://embedding:8080/v1').replace(/\/+$/, '');
const BLOCK = 16;

async function stdinLesen() {
  if (process.stdin.isTTY) return '';
  const teile = [];
  for await (const teil of process.stdin) teile.push(teil);
  return Buffer.concat(teile).toString('utf8');
}

async function einbetten(texte) {
  const antwort = await fetch(`${URL_DIENST}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EINGEBAUTES_EMBEDDING.model, input: texte }),
  });
  const text = await antwort.text();
  if (!antwort.ok) throw new Error(`Embedding-Dienst ${antwort.status}: ${text.slice(0, 300)}`);
  const daten = JSON.parse(text).data;
  if (!Array.isArray(daten) || daten.length !== texte.length) throw new Error('Unerwartete Antwort des Embedding-Dienstes.');
  return daten.map((d) => {
    if (!Array.isArray(d.embedding) || d.embedding.length !== EINGEBAUTES_EMBEDDING.dim) {
      throw new Error(`Vektor mit ${d.embedding?.length} statt ${EINGEBAUTES_EMBEDDING.dim} Werten.`);
    }
    return d.embedding;
  });
}

const cfg = EINGEBAUTES_EMBEDDING;
const signatur = signatureOf(cfg);
const roh = (await stdinLesen()).trim();
const alt = roh ? JSON.parse(roh) : null;
const altAbschnitte = alt?.signatur === signatur && alt?.dim === cfg.dim ? alt.abschnitte || {} : {};

const { chunks } = await loadHelpSource({ fresh: true });
const abschnitte = {};
const offen = [];
for (const chunk of chunks) {
  if (Object.hasOwn(abschnitte, chunk.inhaltHash)) continue;
  const vorhanden = altAbschnitte[chunk.inhaltHash];
  if (dekodiereVektor(vorhanden, cfg.dim)) abschnitte[chunk.inhaltHash] = vorhanden;
  else offen.push(chunk);
}

for (let i = 0; i < offen.length; i += BLOCK) {
  const block = offen.slice(i, i + BLOCK);
  const vektoren = await einbetten(block.map((c) => mitVorsilbe(c.embeddingText, cfg, 'dokument')));
  block.forEach((c, j) => { abschnitte[c.inhaltHash] = kodiereVektor(vektoren[j]); });
  process.stderr.write(`\r${Math.min(i + BLOCK, offen.length)}/${offen.length} eingebettet`);
}
if (offen.length) process.stderr.write('\n');

const weggefallen = Object.keys(altAbschnitte).filter((h) => !Object.hasOwn(abschnitte, h)).length;
process.stderr.write(`${Object.keys(abschnitte).length} Abschnitte: ${offen.length} neu, `
  + `${Object.keys(abschnitte).length - offen.length} übernommen, ${weggefallen} entfallen (${signatur})\n`);
// Erst nach dem vollständigen Schreiben beenden: process.exit() verwirft
// sonst gepufferte Ausgabe an eine Pipe. Beendet werden muss, weil der
// importierte DB-Pool den Prozess sonst offen hält.
const ausgabe = `${JSON.stringify(vektorDatei(signatur, cfg.dim, abschnitte), null, 1)}\n`;
process.stdout.write(ausgabe, () => process.exit(0));
