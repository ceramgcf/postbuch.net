import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import ChatInput from '@/components/chat/ChatInput';
import {
  MessageCircle, Plus, Trash2, Send, Bot, User,
  FileText, ChevronLeft, ChevronRight, Pencil, PencilOff, Check, X, Square,
  Undo2, AlertTriangle, FolderOpen, Brain, ChevronDown, ChevronUp,
  BookOpen,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

// ── PostID-Links im Text rendern ──────────────────────────────────────────────

// Merkt sich vor dem Absprung zu einem Dokument die aktive Konversation und die
// Scrollposition, damit "← Zurück zum Chat" exakt dort landet wo der User war.
function saveChatReturn() {
  try {
    const convId = sessionStorage.getItem('chat-active-conv');
    const el = document.getElementById('chat-scroll-container');
    sessionStorage.setItem('chatReturn', JSON.stringify({
      convId: convId ? Number(convId) : null,
      scroll: el ? el.scrollTop : 0,
    }));
  } catch { /* sessionStorage nicht verfügbar */ }
}

// Zerlegt Text in Spans und klickbare [Axxxxxx]-/[Pxxxxxx]-Links. Akten werden
// dabei genauso verlinkt wie Dokumente; ActionIdLink (weiter unten) übernimmt
// Navigation + Rücksprungmarke (saveChatReturn) für beide Typen einheitlich.
function renderInlineIds(text, keyPrefix = 'id') {
  return text.split(/(\[[AP]\d{6}\])/g).map((part, i) => {
    const m = /^\[([AP])(\d{6})\]$/.exec(part);
    if (m) return <ActionIdLink key={`${keyPrefix}-${i}`} kind={m[1]} id={`${m[1]}${m[2]}`} />;
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function renderWithPostidLinks(text) {
  if (!text) return null;
  // Erst Bold (**…**), dann Post-/AkteID-Links innerhalb der Segmente
  const boldParts = text.split(/(\*\*[^*]+\*\*)/g);
  return boldParts.map((seg, bi) => {
    const boldMatch = /^\*\*([^*]+)\*\*$/.exec(seg);
    const inner = boldMatch ? boldMatch[1] : seg;
    const parts = renderInlineIds(inner, bi);
    return boldMatch ? <strong key={bi}>{parts}</strong> : <span key={bi}>{parts}</span>;
  });
}

// ── #P/#A-Referenz-Chips in Nutzer-Nachrichten ───────────────────────────────

// Chip-Variante für die dunkle Primary-Bubble (ActionIdLink-Blau wäre dort
// schlecht lesbar). Klick navigiert wie ActionIdLink mit Rücksprungmarke.
function UserRefChip({ id }) {
  const navigate = useNavigate();
  const to = id[0] === 'A' ? `/akten/${id}` : `/postbuch/${id}`;
  return (
    <button
      onClick={() => { saveChatReturn(); navigate(to, { state: { from: '/assistent' } }); }}
      className="inline-flex items-center gap-1 rounded-full bg-primary-foreground/20 hover:bg-primary-foreground/30 px-1.5 mx-0.5 font-mono text-[0.85em] align-baseline transition-colors"
    >
      {id[0] === 'A' ? <FolderOpen className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
      {id}
    </button>
  );
}

// Nutzer-Text mit #P000123/#A000045 als klickbare Chips rendern
function renderUserRefs(text) {
  return (text || '').split(/(#[APap]\d{6})/g).map((part, i) => {
    const m = /^#([APap])(\d{6})$/.exec(part);
    if (m) return <UserRefChip key={i} id={m[1].toUpperCase() + m[2]} />;
    return <span key={i}>{part}</span>;
  });
}

// Markdown-Tabellen-Block → echte HTML-Tabelle
function MarkdownTable({ rows }) {
  const parseCells = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const header = parseCells(rows[0]);
  // rows[1] ist die |---|---|-Trennzeile, danach die Datenzeilen
  const body = rows.slice(2).map(parseCells);

  return (
    <div className="overflow-x-auto my-2">
      <table className="text-sm border-collapse w-full">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} className="border border-border bg-muted/70 px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">
                {renderWithPostidLinks(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((cells, ri) => (
            <tr key={ri} className={ri % 2 === 1 ? 'bg-muted/30' : ''}>
              {cells.map((c, ci) => (
                <td key={ci} className="border border-border px-2.5 py-1.5">
                  {renderWithPostidLinks(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isTableLine(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

function isTableSeparator(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

// ── Markdown-ähnliches Rendering (einfach) ───────────────────────────────────

function ChatText({ content }) {
  const lines = (content || '').split('\n');
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Markdown-Tabelle: mind. Header + Separator, dann alle Folgezeilen sammeln
    if (isTableLine(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableRows = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableLine(lines[j])) {
        tableRows.push(lines[j]);
        j++;
      }
      elements.push(<MarkdownTable key={i} rows={tableRows} />);
      i = j;
      continue;
    }

    if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-sm font-semibold mt-3 mb-1">{renderWithPostidLinks(line.slice(4))}</h3>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-base font-semibold mt-3 mb-1">{renderWithPostidLinks(line.slice(3))}</h2>);
    } else if (line.startsWith('# ')) {
      elements.push(<h2 key={i} className="text-base font-bold mt-3 mb-1">{renderWithPostidLinks(line.slice(2))}</h2>);
    } else if (line.startsWith('**') && line.endsWith('**') && line.length > 4) {
      elements.push(<p key={i} className="font-semibold">{renderWithPostidLinks(line.slice(2, -2))}</p>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(<li key={i} className="ml-4 list-disc">{renderWithPostidLinks(line.slice(2))}</li>);
    } else if (line === '---') {
      elements.push(<hr key={i} className="my-3 border-border" />);
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(<p key={i} className="leading-relaxed">{renderWithPostidLinks(line)}</p>);
    }
    i++;
  }
  return <div className="text-sm space-y-0.5">{elements}</div>;
}

// ── Quellen-Block ─────────────────────────────────────────────────────────────

function SourcesList({ sources }) {
  const navigate = useNavigate();
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-3 pt-2 border-t border-border/50">
      <p className="text-[11px] font-medium text-muted-foreground mb-1">Quellen</p>
      <div className="space-y-0.5">
        {sources.map((s) => {
          const isHelp = s.type === 'help';
          if (isHelp) {
            const kapitel = s.betreff || s.kapitel || 'Hilfe';
            const vollerPfad = s.ueberschrift || '';
            const relativerPfad = vollerPfad === kapitel
              ? ''
              : vollerPfad.startsWith(`${kapitel} › `)
                ? vollerPfad.slice(`${kapitel} › `.length)
                : vollerPfad;
            return (
              <button
                key={`hilfe:${s.sourceId || s.route}`}
                onClick={() => { saveChatReturn(); navigate(s.route || '/hilfe', { state: { from: '/assistent' } }); }}
                className="flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400 hover:underline w-full text-left"
              >
                <BookOpen className="h-3 w-3 flex-shrink-0" />
                <span className="font-medium">Hilfe</span>
                <span className="truncate">{kapitel}{relativerPfad ? ` · ${relativerPfad}` : ''}</span>
              </button>
            );
          }
          // Akten-Quellen (s.akteid) neben Dokument-Quellen; alte persistierte
          // Nachrichten kennen nur postid und bleiben kompatibel.
          const isAkte = !!s.akteid;
          const id = s.akteid || s.postid;
          return (
            <button
              key={id}
              onClick={() => { saveChatReturn(); navigate(isAkte ? `/akten/${id}` : `/postbuch/${id}`, { state: { from: '/assistent' } }); }}
              className="flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400 hover:underline w-full text-left"
            >
              {isAkte
                ? <FolderOpen className="h-3 w-3 flex-shrink-0" />
                : <FileText className="h-3 w-3 flex-shrink-0" />}
              <span className="font-mono">[{id}]</span>
              {!isAkte && <span className="text-muted-foreground">{s.briefdatum || '?'}</span>}
              <span className="truncate">{s.betreff || s.art || id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Aktions-Panel (Akten-Änderungen des Assistenten) ─────────────────────────

// Klickbare Akten-/Post-ID (eigene Komponente, damit useNavigate nicht in einer
// je nach Textlänge unterschiedlich oft aufgerufenen Hilfsfunktion landet).
function ActionIdLink({ kind, id }) {
  const navigate = useNavigate();
  const to = kind === 'A' ? `/akten/${id}` : `/postbuch/${id}`;
  return (
    <button
      onClick={() => { saveChatReturn(); navigate(to, { state: { from: '/assistent' } }); }}
      className="font-mono text-[0.95em] text-blue-600 dark:text-blue-400 hover:underline"
    >
      [{id}]
    </button>
  );
}

// Rendert Beschreibungstext mit klickbaren [Axxxxxx]- und [Pxxxxxx]-IDs.
function renderActionText(text) {
  if (!text) return null;
  return renderInlineIds(text, 'a');
}

function ActionsPanel({ msg, onConfirm, onDiscard, onUndo, onActivateWriteMode, busy }) {
  const actions = msg.actions || [];
  if (actions.length === 0) return null;
  // Anforderung des Bearbeiten-Modus ist zwar 'pending', aber keine ausführbare
  // Mutation – separat behandeln, nicht in die Bestätigen/Verwerfen-Karte mischen.
  const writeReq = actions.filter(a => a.status === 'pending' && a.action_type === 'request_write_mode');
  const pending  = actions.filter(a => a.status === 'pending' && a.action_type !== 'request_write_mode');
  const done     = actions.filter(a => a.status === 'done');
  const undone   = actions.filter(a => a.status === 'undone' && a.action_type !== 'request_write_mode');

  return (
    <div className="mt-2 space-y-2 w-full">
      {writeReq.length > 0 && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
          <p className="inline-flex items-center gap-1 text-[11px] font-medium text-primary mb-1">
            <Pencil className="h-3 w-3" /> Bearbeiten-Modus nötig
          </p>
          <ul className="space-y-0.5 mb-2">
            {writeReq.map(a => (
              <li key={a.id} className="text-[11px] text-foreground/90">{renderActionText(a.description)}</li>
            ))}
          </ul>
          <Button size="sm" className="h-7 text-xs gap-1" onClick={onActivateWriteMode} disabled={busy}>
            <Pencil className="h-3 w-3" /> Bearbeiten-Modus aktivieren &amp; fortfahren
          </Button>
        </div>
      )}

      {done.length > 0 && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              <FolderOpen className="h-3 w-3" /> Durchgeführte Änderungen
            </span>
            <button
              onClick={onUndo}
              disabled={busy}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Diese Änderungen rückgängig machen"
            >
              <Undo2 className="h-3 w-3" /> Rückgängig
            </button>
          </div>
          <ul className="space-y-0.5">
            {done.map(a => (
              <li key={a.id} className="flex items-start gap-1 text-[11px]">
                <Check className="h-3 w-3 flex-shrink-0 mt-0.5 text-emerald-600" />
                <span>{renderActionText(a.description)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
          <p className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400 mb-1">
            <AlertTriangle className="h-3 w-3" /> Bestätigung erforderlich
          </p>
          <ul className="space-y-0.5 mb-2">
            {pending.map(a => (
              <li key={a.id} className="text-[11px] text-foreground/90">{renderActionText(a.description)}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={onConfirm} disabled={busy}>
              Ausführen
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onDiscard} disabled={busy}>
              Verwerfen
            </Button>
          </div>
        </div>
      )}

      {undone.length > 0 && done.length === 0 && pending.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
          <ul className="space-y-0.5">
            {undone.map(a => (
              <li key={a.id} className="text-[11px] text-muted-foreground line-through">
                {a.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Nachrichten-Bubble ────────────────────────────────────────────────────────

// Entfernt eine etwaige "Quellen:"-Sektion am Textende – die Quellen werden
// separat als SourcesList gerendert (verhindert doppelte Anzeige).
function stripTrailingSources(content) {
  if (!content) return content;
  return content.replace(/\n-{3,}\s*\n\*{0,2}Quellen:?\*{0,2}\s*\n(\s*\[P\d{6}\][^\n]*\n?)+\s*$/i, '').trimEnd();
}

// Fiktive API-Kosten formatieren. Der Wert ist US-Dollar (Anthropic-Preise),
// darum US-Cent „¢" für kleine Beträge und „$" ab 1 Dollar – konsistent mit der
// Token-Log-Ansicht. Deutsches Zahlenformat (Komma als Dezimaltrenner).
function fmtCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return null;
  const de = (x, d) => x.toFixed(d).replace('.', ',');
  if (n < 0.01) return `${de(n * 100, 3)} ¢`;
  if (n < 1)    return `${de(n * 100, 2)} ¢`;
  return `$${de(n, 2)}`;
}

// „Abo"-Badge für über die Claude-Subscription abgerechnete Antworten
// (Pauschaltarif – die ausgewiesenen Kosten sind rein fiktiv/API-äquivalent).
function AboBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0 text-[10px] font-medium bg-violet-500/15 text-violet-600 dark:text-violet-300"
      title="Über Claude-Subscription abgerechnet (Pauschaltarif) – die Kosten sind fiktiv (API-Äquivalent) und werden nicht berechnet"
    >
      Abo
    </span>
  );
}

function MessageBubble({ msg, isStreaming, onConfirm, onDiscard, onUndo, onActivateWriteMode, actionBusy }) {
  const isUser = msg.role === 'user';
  const hasThinking = !isUser && !!msg.thinking;
  // Aufgeklappt solange gedacht wird, klappt automatisch ein, sobald die
  // eigentliche Antwort zu streamen beginnt – danach vom Nutzer manuell umschaltbar.
  const [thinkingOpen, setThinkingOpen] = useState(true);
  useEffect(() => {
    if (msg.content) setThinkingOpen(false);
  }, [!!msg.content]);
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs ${
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground'
      }`}>
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>

      <div className={`max-w-[78%] min-w-0 ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <div className={`rounded-xl px-3 py-2.5 ${
          isUser
            ? 'bg-primary text-primary-foreground rounded-tr-sm'
            : 'bg-muted/60 rounded-tl-sm'
        }`}>
          {hasThinking && (
            <div className="mb-2 border-b border-border/50 pb-2">
              <button
                type="button"
                onClick={() => setThinkingOpen(o => !o)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Brain className="h-3 w-3" />
                Nachgedacht
                {thinkingOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {thinkingOpen && (
                <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap italic">{msg.thinking}</p>
              )}
            </div>
          )}
          {isUser
            ? <p className="text-sm whitespace-pre-wrap">{renderUserRefs(msg.content)}</p>
            : <ChatText content={isStreaming ? msg.content : stripTrailingSources(msg.content)} />
          }
          {isStreaming && (
            <span className="inline-block ml-1 animate-pulse text-muted-foreground">▍</span>
          )}
        </div>

        {!isUser && msg._aborted && (
          <p className="text-xs text-muted-foreground italic px-1">Abgebrochen.</p>
        )}

        {!isUser && (
          <SourcesList sources={msg.sources} />
        )}

        {!isUser && (
          <ActionsPanel
            msg={msg}
            onConfirm={onConfirm}
            onDiscard={onDiscard}
            onUndo={onUndo}
            onActivateWriteMode={onActivateWriteMode}
            busy={actionBusy}
          />
        )}

        {!isUser && (msg.cost_usd != null || msg.billing === 'subscription'
          || (msg.sources || []).some((s) => s.type === 'help')) && (() => {
          const isAbo = msg.billing === 'subscription';
          const cost = fmtCost(msg.cost_usd);
          const hilfeAnzahl = (msg.sources || []).filter((s) => s.type === 'help').length;
          return (
            <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground px-1">
              {msg.tool_calls > 0 ? <span>{msg.tool_calls} Dokumente gelesen</span> : null}
              {msg.tool_calls > 0 && hilfeAnzahl > 0 ? <span>·</span> : null}
              {hilfeAnzahl > 0 ? <span>{hilfeAnzahl} Hilfeabschnitt{hilfeAnzahl === 1 ? '' : 'e'} geprüft</span> : null}
              {(msg.tool_calls > 0 || hilfeAnzahl > 0) && (cost || isAbo) ? <span>·</span> : null}
              {isAbo && <AboBadge />}
              {cost && (
                <span
                  className={isAbo ? 'line-through opacity-60' : undefined}
                  title={isAbo ? 'Fiktive API-Kosten – im Abo nicht berechnet' : 'Fiktive API-Kosten (API-Äquivalent)'}
                >
                  ~{cost}
                </span>
              )}
            </p>
          );
        })()}
      </div>
    </div>
  );
}

// ── Fortschrittsanzeige ───────────────────────────────────────────────────────

function ProgressIndicator({ label, elapsed = 0 }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 h-7 w-7 rounded-full bg-muted flex items-center justify-center">
        <Spinner className="h-3.5 w-3.5" />
      </div>
      <div className="bg-muted/60 rounded-xl rounded-tl-sm px-3 py-2.5 text-sm text-muted-foreground italic">
        {label || 'Arbeite…'}
        {/* Ab 30 s verstrichene Zeit zeigen – Signal, dass noch gearbeitet wird;
            ab 90 s dezenter Farbhinweis „dauert länger als üblich" */}
        {elapsed >= 30 && (
          <div className={`not-italic text-xs mt-0.5 ${elapsed >= 90 ? 'text-amber-500' : ''}`}>
            {elapsed} Sekunden
          </div>
        )}
      </div>
    </div>
  );
}

// Platzhalter nach Nutzer-Abbruch, wenn noch keine Antwort gestreamt wurde –
// bleibt im Verlauf sichtbar, damit klar ist, wo der Lauf endete.
function AbortedIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 h-7 w-7 rounded-full bg-muted flex items-center justify-center">
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="bg-muted/60 rounded-xl rounded-tl-sm px-3 py-2.5 text-sm text-muted-foreground italic">
        Abgebrochen.
      </div>
    </div>
  );
}

// ── Konversationseintrag ──────────────────────────────────────────────────────

function ConvItem({ conv, isActive, onClick, onDelete, onRename }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle]     = useState(conv.title || '');
  const inputRef = useRef(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const save = () => {
    onRename(title.trim() || null);
    setEditing(false);
  };

  return (
    <div
      className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
        isActive ? 'bg-accent' : 'hover:bg-accent/50'
      }`}
      onClick={onClick}
    >
      <MessageCircle className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />

      {editing ? (
        <input
          ref={inputRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-background border border-border rounded px-1.5 py-0.5 text-xs"
        />
      ) : (
        <span className="flex-1 min-w-0 text-xs truncate">
          {conv.title || 'Neue Konversation'}
        </span>
      )}

      <div className="flex-shrink-0 flex items-center gap-0.5">
        {editing ? (
          <>
            <button onClick={e => { e.stopPropagation(); save(); }} className="p-0.5 hover:text-foreground text-muted-foreground" title="Speichern"><Check className="h-3 w-3" /></button>
            <button onClick={e => { e.stopPropagation(); setEditing(false); }} className="p-0.5 hover:text-foreground text-muted-foreground" title="Abbrechen"><X className="h-3 w-3" /></button>
          </>
        ) : (
          <>
            <button onClick={e => { e.stopPropagation(); setTitle(conv.title || ''); setEditing(true); }} className="p-0.5 hover:text-foreground text-muted-foreground" title="Umbenennen"><Pencil className="h-3 w-3" /></button>
            <button
              onClick={e => {
                e.stopPropagation();
                if (window.confirm(`Gespräch "${conv.title || 'Neue Konversation'}" wirklich löschen?`)) onDelete();
              }}
              className="p-0.5 hover:text-destructive text-muted-foreground"
              title="Gespräch löschen"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function AssistantPage() {
  const navigate      = useNavigate();
  const location      = useLocation();
  const queryClient   = useQueryClient();
  const { canWrite }  = useAuth();
  // Bearbeiten-Modus (Schreibaktionen des Assistenten) – pro Chat, zwischen Turns
  // umschaltbar. Standard aus: spart Tool-Overhead. Nur relevant für Schreib-Rollen.
  const [writeMode, setWriteMode] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [messages,  setMessages]  = useState([]);
  const [input,     setInput]     = useState('');
  const [streaming, setStreaming] = useState(false);
  const [progress,  setProgress]  = useState(null);
  const [elapsed,   setElapsed]   = useState(0); // Sekunden seit Stream-Start (Transparenz bei langen Läufen)
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef   = useRef(null);
  const textareaRef      = useRef(null);
  const scrollRestoreRef = useRef(null); // Scrollposition beim Rücksprung aus Dokument
  const abortRef         = useRef(null); // AbortController des laufenden Streams (Stop-Button)
  const [actionBusyId, setActionBusyId] = useState(null); // message_id mit laufender Confirm/Undo/Discard-Aktion

  // Sekundenzähler während des Streamings
  useEffect(() => {
    if (!streaming) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  // Aktive Konversation persistieren (für saveChatReturn beim Dokument-Absprung)
  useEffect(() => {
    try {
      if (activeId) sessionStorage.setItem('chat-active-conv', String(activeId));
    } catch { /* sessionStorage nicht verfügbar */ }
  }, [activeId]);

  // Von einer Detailseite mitgebrachte Referenz ("Im Chat besprechen"): Input
  // einmalig vorbefüllen, NICHT automatisch senden – der Nutzer ergänzt seine
  // Frage selbst. Danach State neutralisieren, damit Reload nicht erneut füllt.
  const prefillConsumedRef = useRef(false);
  useEffect(() => {
    const prefill = location.state?.prefill;
    if (!prefill || prefillConsumedRef.current) return;
    prefillConsumedRef.current = true;
    setInput(prefill);
    setTimeout(() => textareaRef.current?.focus(), 100);
    navigate('/assistent', { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Rücksprung aus Dokument: Konversation + Scrollposition wiederherstellen
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('chatReturn');
      if (!raw) return;
      sessionStorage.removeItem('chatReturn');
      const { convId, scroll } = JSON.parse(raw);
      if (convId) {
        setActiveId(convId);
        scrollRestoreRef.current = scroll ?? 0;
      }
    } catch { /* defekter Eintrag – ignorieren */ }
  }, []);

  // Konversationsliste
  const { data: convsData, isLoading: convsLoading } = useQuery({
    queryKey: ['chat-conversations'],
    queryFn: () => api.chat.listConversations(),
  });
  const conversations = convsData?.conversations || [];

  // Aktive Konversation laden
  const { data: convData } = useQuery({
    queryKey: ['chat-conversation', activeId],
    queryFn: () => api.chat.getConversation(activeId),
    enabled: !!activeId,
  });

  useEffect(() => {
    if (convData) {
      // "thinking" wird bewusst nicht persistiert (chat_messages hat dafür keine
      // Spalte) – ein Refetch dieser Query (z.B. das invalidateQueries nach jeder
      // fertigen Antwort oder nach Akten-Aktionen) würde die gerade gestreamte
      // Denkblase sonst nicht einklappen, sondern komplett verschwinden lassen.
      // Deshalb aus dem noch vorhandenen lokalen State übernehmen.
      setMessages(prev => (convData.messages || []).map(m => {
        if (m.thinking) return m;
        const local = prev.find(p => p.dbId === m.id || p.id === m.id);
        return local?.thinking ? { ...m, thinking: local.thinking } : m;
      }));
    }
  }, [convData]);

  // Auto-scroll – beim Rücksprung aus einem Dokument stattdessen die alte Position wiederherstellen
  useEffect(() => {
    if (scrollRestoreRef.current != null) {
      if (messages.length > 0) {
        const el = document.getElementById('chat-scroll-container');
        if (el) el.scrollTop = scrollRestoreRef.current;
        scrollRestoreRef.current = null;
      }
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, progress]);

  // Neue Konversation
  const createConv = useMutation({
    mutationFn: () => api.chat.createConversation(),
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
      setActiveId(conv.id);
      setMessages([]);
    },
  });

  // Konversation löschen
  const deleteConv = useMutation({
    mutationFn: (id) => api.chat.deleteConversation(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
      if (activeId === id) { setActiveId(null); setMessages([]); }
    },
  });

  // Konversation umbenennen
  const renameConv = useMutation({
    mutationFn: ({ id, title }) => api.chat.renameConversation(id, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['chat-conversations'] }),
  });

  const sendMessage = useCallback(async (opts = {}) => {
    // opts.text/opts.write erlauben ein programmatisches Erneut-Senden (z.B. nach
    // Aktivierung des Bearbeiten-Modus), unabhängig von input/writeMode-State.
    const text  = (typeof opts.text === 'string' ? opts.text : input).trim();
    const write = typeof opts.write === 'boolean' ? opts.write : writeMode;
    if (!text || streaming) return;

    let convId = activeId;
    if (!convId) {
      const conv = await createConv.mutateAsync();
      convId = conv.id;
    }

    const userMsg = { role: 'user', content: text, id: `tmp-${Date.now()}` };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setProgress('Starte Recherche…');

    let streamingContent = '';
    let streamingThinking = '';
    let streamingSources = [];
    let streamingActions = null;
    let streamingDbId = null;

    // Streaming-Platzhalter
    const streamId = `stream-${Date.now()}`;
    setMessages(prev => [...prev, { role: 'assistant', content: '', id: streamId, _streaming: true }]);

    const controller = new AbortController();
    abortRef.current = controller;

    await api.chat.sendMessageStream(
      convId,
      userMsg.content,
      (label) => setProgress(label),
      (text) => {
        streamingContent += text;
        setMessages(prev => prev.map(m =>
          m.id === streamId ? { ...m, content: streamingContent } : m
        ));
      },
      (sources) => { streamingSources = sources; },
      (doneData) => {
        streamingDbId = doneData.message_id ?? streamingDbId;
        setMessages(prev => prev.map(m =>
          m.id === streamId
            ? { ...m, _streaming: false, sources: streamingSources, cost_usd: doneData.cost_usd, tool_calls: doneData.tool_calls, billing: doneData.billing, actions: streamingActions || m.actions, dbId: streamingDbId }
            : m
        ));
        setProgress(null);
        setStreaming(false);
        queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
        queryClient.invalidateQueries({ queryKey: ['chat-conversation', convId] });
      },
      (errMsg) => {
        setMessages(prev => prev.filter(m => m.id !== streamId).concat({
          role: 'assistant',
          content: `Fehler: ${errMsg}`,
          id: `err-${Date.now()}`,
          _error: true,
        }));
        setProgress(null);
        setStreaming(false);
        // Falls der Agent vor dem Fehler bereits Änderungen ausgeführt hat, sind
        // diese serverseitig als Hinweis-Nachricht (mit Undo) persistiert – neu laden.
        queryClient.invalidateQueries({ queryKey: ['chat-conversation', convId] });
        queryClient.invalidateQueries({ queryKey: ['akten'] });
      },
      {
        signal: controller.signal,
        writeEnabled: write, // Bearbeiten-Modus dieses Chats an den Server melden
        onThinking: (text) => {
          streamingThinking += text;
          setMessages(prev => prev.map(m =>
            m.id === streamId ? { ...m, thinking: streamingThinking } : m
          ));
        },
        // Akten-Änderungen des Assistenten: sofort am Platzhalter anzeigen
        onActions: (data) => {
          streamingActions = data.actions;
          streamingDbId = data.message_id ?? streamingDbId;
          setMessages(prev => prev.map(m =>
            m.id === streamId ? { ...m, actions: data.actions, dbId: data.message_id } : m
          ));
        },
        // Nutzer hat gestoppt: teilgestreamte Antwort behalten und markieren,
        // leeren Platzhalter durch „Abgebrochen."-Indikator ersetzen.
        onAborted: () => {
          setMessages(prev => prev.map(m =>
            m.id === streamId ? { ...m, _streaming: false, _aborted: true } : m
          ));
          setProgress(null);
          setStreaming(false);
        },
      },
    );
    abortRef.current = null;
  }, [input, streaming, activeId, writeMode, createConv, queryClient]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Akten-Aktionen bestätigen / verwerfen / rückgängig machen ──────────────
  const applyActionResult = useCallback((messageId, data) => {
    setMessages(prev => prev.map(m => ((m.dbId ?? m.id) === messageId ? { ...m, actions: data.actions } : m)));
    // Akten-Ansichten spiegeln die Änderung sofort wider
    queryClient.invalidateQueries({ queryKey: ['akten'] });
    queryClient.invalidateQueries({ queryKey: ['stats'] });
    queryClient.invalidateQueries({ queryKey: ['chat-conversation', activeId] });
  }, [queryClient, activeId]);

  const runAction = useCallback(async (msg, fn) => {
    const messageId = msg.dbId ?? msg.id;
    // Nur echte (persistierte) Nachrichten haben eine DB-ID – bigserial-Spalten
    // liefert node-pg aber als String (kein Type-Parser für OID 20), darum hier
    // rein numerisch statt strikt auf 'number' prüfen. Client-Platzhalter-IDs
    // ("stream-…", "tmp-…", "err-…") fallen dabei weiterhin durch.
    if (messageId == null || !/^\d+$/.test(String(messageId))) return;
    setActionBusyId(messageId);
    try {
      const data = await fn(messageId);
      applyActionResult(messageId, data);
    } catch (e) {
      window.alert(e.message || 'Aktion fehlgeschlagen');
    } finally {
      setActionBusyId(null);
    }
  }, [applyActionResult]);

  const confirmActions = useCallback((msg) => runAction(msg, api.chat.confirmActions), [runAction]);
  const discardActions = useCallback((msg) => runAction(msg, api.chat.discardActions), [runAction]);
  const undoActions    = useCallback((msg) => runAction(msg, api.chat.undoActions), [runAction]);

  // Nutzer klickt „Bearbeiten-Modus aktivieren & fortfahren" an der Anforderungs-
  // karte: Schreibmodus einschalten, den (informellen) Anforderungs-Marker
  // verwerfen und die vorausgehende Nutzerfrage erneut senden – diesmal mit
  // aktivierten Schreib-Werkzeugen. Der Assistent selbst schaltet NICHT scharf;
  // die Zustimmung bleibt beim Menschen (bewusster Klick).
  const activateWriteModeAndRetry = useCallback((assistantMsg) => {
    setWriteMode(true);
    const mid = assistantMsg.dbId ?? assistantMsg.id;
    if (typeof mid === 'number') {
      api.chat.discardActions(mid).then(data => applyActionResult(mid, data)).catch(() => {});
    }
    // Vorausgehende Nutzer-Nachricht als erneuten Prompt bestimmen.
    const idx = messages.findIndex(m => (m.dbId ?? m.id) === mid);
    let prompt = '';
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { prompt = messages[i].content; break; }
    }
    if (prompt) sendMessage({ text: prompt, write: true });
  }, [messages, sendMessage, applyActionResult]);

  const selectConversation = (id) => {
    setActiveId(id);
    setMessages([]);
    setProgress(null);
    setWriteMode(false); // Bearbeiten-Modus ist pro Chat – beim Wechsel zurücksetzen
  };

  // Bearbeiten-Modus-Umschalter (Stift) – nur für Schreib-Rollen. Aus = Assistent
  // liest nur (schlanker Prompt, keine Schreib-Tools). An = darf Akten pflegen;
  // destruktive/überschreibende Aktionen werden weiterhin erst nach Bestätigung
  // ausgeführt. Pro Chat, zwischen Turns umschaltbar.
  const writeToggle = canWrite ? (
    <Button
      type="button"
      onClick={() => setWriteMode(v => !v)}
      disabled={streaming}
      size="icon"
      variant="ghost"
      className={`h-[52px] w-[52px] rounded-xl shrink-0 border ${
        writeMode ? 'border-primary text-primary bg-primary/10 hover:bg-primary/15' : 'border-border text-muted-foreground'
      }`}
      title={writeMode
        ? 'Bearbeiten-Modus AN: Der Assistent darf Akten anlegen und pflegen. Löschende oder überschreibende Aktionen werden dir weiterhin erst zur Bestätigung vorgelegt. Klicken zum Ausschalten.'
        : 'Bearbeiten-Modus AUS: Der Assistent liest und recherchiert nur. Klicken, damit er Akten anlegen/pflegen darf.'}
      aria-pressed={writeMode}
    >
      {writeMode ? <Pencil className="h-4 w-4" /> : <PencilOff className="h-4 w-4" />}
    </Button>
  ) : null;

  return (
    <div className="flex h-full overflow-hidden">

      {/* Sidebar – Konversationsliste */}
      <div className={`flex-shrink-0 flex flex-col border-r border-border bg-background transition-all duration-200 ${sidebarOpen ? 'w-60' : 'w-0 overflow-hidden'}`}>
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Gespräche</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => { createConv.mutate(); setWriteMode(false); }}
            title="Neues Gespräch"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {convsLoading && <div className="flex justify-center py-4"><Spinner className="h-4 w-4" /></div>}
          {conversations.length === 0 && !convsLoading && (
            <p className="text-xs text-muted-foreground text-center py-4">Noch keine Gespräche</p>
          )}
          {conversations.map(conv => (
            <ConvItem
              key={conv.id}
              conv={conv}
              isActive={activeId === conv.id}
              onClick={() => selectConversation(conv.id)}
              onDelete={() => deleteConv.mutate(conv.id)}
              onRename={(title) => renameConv.mutate({ id: conv.id, title })}
            />
          ))}
        </div>
      </div>

      {/* Toggle-Button Sidebar */}
      <button
        onClick={() => setSidebarOpen(v => !v)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-background border border-border rounded-r-md p-1 text-muted-foreground hover:text-foreground transition-all"
        style={{ left: sidebarOpen ? 240 : 0 }}
        title={sidebarOpen ? 'Sidebar einklappen' : 'Sidebar aufklappen'}
      >
        {sidebarOpen ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>

      {/* Hauptbereich */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Leer-State */}
        {!activeId && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
            <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
              <Bot className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Büroassistent</h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Stelle Fragen zu deinen Dokumenten. Beispiele:
              </p>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-sm">
              {[
                'Wann war mein letzter Zahnarztbesuch?',
                'Bei welchen Verträgen läuft in 2 Monaten eine Kündigungsfrist aus?',
                'Zeige meine Gehaltsentwicklung der letzten 3 Jahre.',
              ].map(example => (
                <button
                  key={example}
                  onClick={() => { createConv.mutate(); setInput(example); setTimeout(() => textareaRef.current?.focus(), 100); }}
                  className="text-left text-sm px-4 py-2.5 rounded-xl border border-border hover:bg-accent transition-colors"
                >
                  {example}
                </button>
              ))}
            </div>
            <Button onClick={() => createConv.mutate()} className="mt-2">
              <Plus className="h-4 w-4 mr-1.5" />
              Neues Gespräch
            </Button>
          </div>
        )}

        {/* Nachrichtenverlauf */}
        {activeId && (
          <div id="chat-scroll-container" className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            {messages.map((msg) => (
              msg._aborted && !msg.content
                ? <AbortedIndicator key={msg.id} />
                : <MessageBubble
                    key={msg.id || `${msg.role}-${msg.created_at}`}
                    msg={msg}
                    isStreaming={!!msg._streaming}
                    onConfirm={() => confirmActions(msg)}
                    onDiscard={() => discardActions(msg)}
                    onUndo={() => undoActions(msg)}
                    onActivateWriteMode={() => activateWriteModeAndRetry(msg)}
                    actionBusy={actionBusyId === (msg.dbId ?? msg.id)}
                  />
            ))}

            {streaming && progress && messages[messages.length - 1]?.role !== 'assistant' && (
              <ProgressIndicator label={progress} elapsed={elapsed} />
            )}

            {streaming && progress && messages[messages.length - 1]?._streaming && (
              <p className="text-xs text-muted-foreground pl-10 italic">
                {progress}
                {elapsed >= 30 && <span className={`not-italic ml-2 ${elapsed >= 90 ? 'text-amber-500' : ''}`}>· {elapsed} s</span>}
              </p>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Eingabe */}
        <div className="border-t border-border p-3">
          {!activeId && (
            <div className="flex gap-2">
              <ChatInput
                textareaRef={textareaRef}
                value={input}
                onChange={setInput}
                onSend={sendMessage}
                disabled={streaming}
                placeholder="Frage stellen und Enter drücken… (#P/#A referenziert Dokumente/Akten)"
              />
              {writeToggle}
              <Button
                onClick={streaming ? stopStreaming : sendMessage}
                disabled={!streaming && !input.trim()}
                size="icon"
                variant={streaming ? 'destructive' : 'default'}
                className="h-[52px] w-[52px] rounded-xl"
                title={streaming ? 'Anfrage stoppen' : 'Senden'}
              >
                {streaming ? <Square className="h-4 w-4 fill-current" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          )}

          {activeId && (
            <div className="flex gap-2">
              <ChatInput
                textareaRef={textareaRef}
                value={input}
                onChange={setInput}
                onSend={sendMessage}
                disabled={streaming}
                placeholder="Nachricht (Enter sendet, Shift+Enter Zeilenumbruch, #P/#A referenziert)…"
              />
              {writeToggle}
              <Button
                onClick={streaming ? stopStreaming : sendMessage}
                disabled={!streaming && !input.trim()}
                size="icon"
                variant={streaming ? 'destructive' : 'default'}
                className="h-[52px] w-[52px] rounded-xl"
                title={streaming ? 'Anfrage stoppen' : 'Senden'}
              >
                {streaming ? <Square className="h-4 w-4 fill-current" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
