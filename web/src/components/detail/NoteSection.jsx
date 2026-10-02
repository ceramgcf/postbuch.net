import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Pencil, Trash2, NotebookPen, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUpdateNote } from '@/hooks/usePostbuch';
import { useAuth } from '@/hooks/useAuth';
import { preprocessRichText } from '@/lib/richText';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

/**
 * Custom markdown components – applies Tailwind prose-like styling inline
 * so we don't need @tailwindcss/typography.
 * Accepts `fromPath` so internal [[[Pxxxxxx]]] links carry back-navigation state.
 */
function makeMdComponents(fromPath) {
  return {
    h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1 first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="text-base font-semibold mt-3 mb-1 first:mt-0">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-0.5 first:mt-0">{children}</h3>,
    p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5 pl-1">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5 pl-1">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through opacity-60">{children}</del>,
    code: ({ inline, children }) =>
      inline
        ? <code className="bg-black/10 rounded px-1 py-0.5 text-xs font-mono">{children}</code>
        : <pre className="bg-black/10 rounded p-2 text-xs font-mono overflow-x-auto my-2 whitespace-pre-wrap"><code>{children}</code></pre>,
    pre: ({ children }) => <>{children}</>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-current/40 pl-3 my-2 opacity-70">{children}</blockquote>
    ),
    a: ({ href, children }) =>
      href?.startsWith('/')
        ? <Link to={href} state={fromPath ? { from: fromPath } : undefined} className="underline underline-offset-2 text-primary hover:opacity-80">{children}</Link>
        : <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-80">{children}</a>,
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="text-xs border-collapse w-full">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-current/20 px-2 py-1 font-semibold text-left">{children}</th>,
    td: ({ children }) => <td className="border border-current/20 px-2 py-1">{children}</td>,
    hr: () => <hr className="my-3 border-current/20" />,
  };
}

/**
 * NoteSection – shows/edits a markdown note.
 * - Default: uses useUpdateNote(postid) internally for document notes.
 * - Custom: pass onSave(notiz) + isPendingExternal to use with any entity (e.g. Akte).
 */
export function NoteSection({ postid, notiz, onSave: onSaveExternal, isPending: isPendingExternal }) {
  const { pathname } = useLocation();
  const mdComponents = makeMdComponents(pathname);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef(null);
  const { mutate: updateNote, isPending: isPendingInternal } = useUpdateNote();
  const { canWrite } = useAuth();
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  const isPending = isPendingExternal ?? isPendingInternal;
  const hasNote = !!notiz;

  function startEdit() {
    setDraft(notiz || '');
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft('');
  }

  function saveNote() {
    const trimmed = draft.trim();
    const newNotiz = trimmed || null;
    if (onSaveExternal) {
      // Undoable action is handled by the parent (e.g. AkteDetailPage.handleUpdateField)
      onSaveExternal(newNotiz);
      setEditing(false);
    } else {
      const oldNotiz = notiz;
      updateNote(
        { postid, notiz: newNotiz },
        { onSuccess: () => {
            setEditing(false);
            pushAction(
              'Notiz gespeichert',
              async () => { await api.postbuch.update(postid, { notiz: oldNotiz }); qc.invalidateQueries({ queryKey: ['postbuch'] }); },
              async () => { await api.postbuch.update(postid, { notiz: newNotiz }); qc.invalidateQueries({ queryKey: ['postbuch'] }); },
            );
          }
        }
      );
    }
  }

  function deleteNote() {
    if (onSaveExternal) {
      // Undoable action is handled by the parent (e.g. AkteDetailPage.handleUpdateField)
      onSaveExternal(null);
    } else {
      const oldNotiz = notiz;
      updateNote(
        { postid, notiz: null },
        { onSuccess: () => {
            pushAction(
              'Notiz gelöscht',
              async () => { await api.postbuch.update(postid, { notiz: oldNotiz }); qc.invalidateQueries({ queryKey: ['postbuch'] }); },
              async () => { await api.postbuch.update(postid, { notiz: null }); qc.invalidateQueries({ queryKey: ['postbuch'] }); },
            );
          }
        }
      );
    }
  }

  // Auto-focus and auto-grow textarea
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(draft.length, draft.length);
      adjustHeight(textareaRef.current);
    }
  }, [editing]);

  function adjustHeight(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(80, el.scrollHeight) + 'px';
  }

  function handleKeyDown(e) {
    // Ctrl+Enter or Cmd+Enter saves
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveNote();
    }
    // Escape cancels
    if (e.key === 'Escape') {
      cancelEdit();
    }
  }

  /* ── No note, not editing ── */
  if (!hasNote && !editing) {
    if (!canWrite) return null;
    return (
      <div className="flex justify-start">
        <Button
          variant="ghost"
          size="sm"
          onClick={startEdit}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <NotebookPen className="h-3.5 w-3.5" />
          Notiz hinzufügen
        </Button>
      </div>
    );
  }

  /* ── Editing mode ── */
  if (editing) {
    return (
      <div
        className="rounded-lg border border-amber-200/80 overflow-hidden"
        style={{ backgroundColor: 'oklch(0.98 0.04 90)' }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-200/60">
          <NotebookPen className="h-3.5 w-3.5 text-amber-700/70" />
          <span className="text-xs font-medium uppercase tracking-wider text-amber-800/60">
            Notiz bearbeiten
          </span>
          <span className="ml-auto text-xs text-amber-700/50">Markdown wird unterstützt · Strg+Enter speichern</span>
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            adjustHeight(e.target);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Notiz eingeben… Markdown wird unterstützt."
          className="w-full resize-none bg-transparent px-3 py-3 text-sm font-mono leading-relaxed
                     text-amber-950 placeholder:text-amber-800/35 outline-none min-h-[80px]"
          style={{ height: 'auto' }}
          disabled={isPending}
          rows={4}
        />
        <div className="flex items-center gap-2 justify-end px-3 py-2 border-t border-amber-200/60">
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelEdit}
            disabled={isPending}
            className="gap-1 text-muted-foreground hover:text-foreground h-7 px-2"
          >
            <X className="h-3.5 w-3.5" /> Abbrechen
          </Button>
          <Button
            size="sm"
            onClick={saveNote}
            disabled={isPending}
            className="gap-1 h-7 px-3"
          >
            <Check className="h-3.5 w-3.5" />
            {isPending ? 'Speichern…' : 'Speichern'}
          </Button>
        </div>
      </div>
    );
  }

  /* ── Display mode (note exists) ── */
  return (
    <div
      className="rounded-lg border border-amber-200/80"
      style={{ backgroundColor: 'oklch(0.98 0.04 90)' }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-200/60">
        <NotebookPen className="h-3.5 w-3.5 text-amber-700/70" />
        <span className="text-xs font-medium uppercase tracking-wider text-amber-800/60">Notiz</span>
        <div className="ml-auto flex items-center gap-1">
          {canWrite && (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={startEdit}
                className="h-6 w-6 text-amber-700/60 hover:text-amber-900 hover:bg-amber-100/60"
                title="Notiz bearbeiten"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={deleteNote}
                disabled={isPending}
                className="h-6 w-6 text-amber-700/60 hover:text-destructive hover:bg-amber-100/60"
                title="Notiz löschen"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="px-4 py-3 text-sm text-amber-950">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {preprocessRichText(notiz)}
        </ReactMarkdown>
      </div>
    </div>
  );
}
