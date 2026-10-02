import { useState, useEffect, useRef, useMemo } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useQuery } from '@tanstack/react-query';
import * as LucideIcons from 'lucide-react';
import { ShieldCheck, X, Printer } from 'lucide-react';
import { renderLabelCanvas, downloadLabelPng } from '@/lib/labelRenderer';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { useVerbleibKategorien } from '@/hooks/useVerbleib';
import { useVerbleibAblagen, useRecentAblagen } from '@/hooks/useVerbleibAblagen';
import { useUpdatePostbuch } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { usePrinter } from '@/contexts/PrinterContext';

const FALLBACK_ICON = LucideIcons.FileQuestionMark;
const PencilIcon = LucideIcons.Pencil;
const CheckIcon = LucideIcons.Check;

function resolveIcon(name) {
  return LucideIcons[name] ?? FALLBACK_ICON;
}

function VerbleibIcon({ name, className }) {
  const Icon = resolveIcon(name);
  return <Icon className={className} />;
}

function iconToSvg(name) {
  const Icon = resolveIcon(name);
  return renderToStaticMarkup(<Icon size={64} color="#000" strokeWidth={2.5} />);
}

export function VerbleibBadge({ data }) {
  const { canWrite } = useAuth();
  const { isConnected, connect, print } = usePrinter();
  const [open, setOpen] = useState(false);
  const [ortQuery, setOrtQuery] = useState('');
  const [ortDropdownOpen, setOrtDropdownOpen] = useState(false);
  const ortInputRef = useRef(null);
  const wrapperRef = useRef(null);

  const { data: kategorienData } = useVerbleibKategorien();
  const { data: appSettings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    staleTime: 5 * 60 * 1000,
  });
  const update = useUpdatePostbuch();
  const { pushAction } = useUndoHistory();

  const kategorien = kategorienData?.data ?? [];

  const verbleib = data.verbleib ?? null;
  const urkundeFlag = data.original_urkunde ?? false;
  const savedAblage = data.verbleib_ablage ?? null;

  const isDefault = !verbleib || verbleib.id === 1;
  const isEmpty = isDefault && !urkundeFlag && !savedAblage;

  const hasKategorie = verbleib?.id && verbleib.id !== 1;

  // Ablagen für die aktuelle Kategorie (nur laden wenn Dropdown offen & Kategorie gesetzt)
  const { data: ablagenData } = useVerbleibAblagen(
    { kategorie_id: verbleib?.id, archived: 'false' },
    { enabled: open && hasKategorie }
  );
  // Nur echte Ablagen (keine losen Kategorie-Einträge mit name=null)
  const ablagen = (ablagenData?.data ?? []).filter((a) => a.name !== null);

  const { getRecents, addRecent } = useRecentAblagen(verbleib?.id);

  useEffect(() => {
    if (!open) {
      setOrtDropdownOpen(false);
      setOrtQuery('');
      return;
    }
    function onDocClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function handleSelectKategorie(id) {
    const newId = id === (verbleib?.id ?? null) ? null : id;
    const oldId = verbleib?.id ?? null;
    const oldAblageId = savedAblage?.id ?? null;
    update.mutate(
      { postid: data.postid, data: { verbleib_id: newId } },
      {
        onSuccess: () => {
          pushAction(
            'Originalverbleib geändert',
            () => update.mutateAsync({ postid: data.postid, data: { verbleib_id: oldId, verbleib_ablage_id: oldAblageId } }),
            () => update.mutateAsync({ postid: data.postid, data: { verbleib_id: newId } }),
          );
        },
      }
    );
    if (!urkundeFlag) setOpen(false);
  }

  function handleToggleUrkunde() {
    const newFlag = !urkundeFlag;
    update.mutate(
      { postid: data.postid, data: { original_urkunde: newFlag } },
      {
        onSuccess: () => {
          pushAction(
            newFlag ? '„Niemals aussondern" gesetzt' : '„Niemals aussondern" entfernt',
            () => update.mutateAsync({ postid: data.postid, data: { original_urkunde: urkundeFlag } }),
            () => update.mutateAsync({ postid: data.postid, data: { original_urkunde: newFlag } }),
          );
        },
      }
    );
  }

  function handleSelectAblage(ablage) {
    addRecent(ablage.id);
    const oldAblageId = savedAblage?.id ?? null;
    update.mutate(
      { postid: data.postid, data: { verbleib_ablage_id: ablage.id } },
      {
        onSuccess: () => {
          pushAction(
            'Aufbewahrungsort geändert',
            () => update.mutateAsync({ postid: data.postid, data: { verbleib_ablage_id: oldAblageId } }),
            () => update.mutateAsync({ postid: data.postid, data: { verbleib_ablage_id: ablage.id } }),
          );
        },
      }
    );
    setOrtQuery('');
    setOrtDropdownOpen(false);
  }

  function handleClearAblage() {
    const oldAblageId = savedAblage?.id ?? null;
    update.mutate(
      { postid: data.postid, data: { verbleib_ablage_id: null } },
      {
        onSuccess: () => {
          pushAction(
            'Aufbewahrungsort entfernt',
            () => update.mutateAsync({ postid: data.postid, data: { verbleib_ablage_id: oldAblageId } }),
            () => update.mutateAsync({ postid: data.postid, data: { verbleib_ablage_id: null } }),
          );
        },
      }
    );
    setOrtQuery('');
    setOrtDropdownOpen(false);
  }

  const filteredAblagen = useMemo(() => {
    if (!ablagen.length) return [];
    if (!ortQuery.trim()) {
      // Ohne Eingabe: zuletzt genutzte zuerst
      const recentIds = getRecents();
      const recentAblagen = recentIds
        .map((id) => ablagen.find((a) => a.id === id))
        .filter(Boolean);
      const otherAblagen = ablagen.filter((a) => !recentIds.includes(a.id));
      return [...recentAblagen, ...otherAblagen].slice(0, 8);
    }
    const q = ortQuery.trim().toLowerCase();
    return ablagen.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 8);
  }, [ablagen, ortQuery, getRecents]);

  async function handlePrintLabel() {
    setOpen(false);
    const verbleibIconSvg = verbleib?.icon ? iconToSvg(verbleib.icon) : null;
    const urkundeIconSvg = urkundeFlag ? iconToSvg('ShieldCheck') : null;
    const instanceName = appSettings?.instance_name?.value?.trim() ?? '';
    const canvas = await renderLabelCanvas(data.postid, {
      verbleibIconSvg,
      urkundeIconSvg,
      instanceName,
    });

    if (isConnected) {
      try {
        await print(canvas);
        return;
      } catch {
        // Drucker-Fehler: Fallback auf Download
      }
    } else {
      // Kein Drucker verbunden: versuche zu verbinden (Button-Click = User Gesture)
      try {
        await connect();
        await print(canvas);
        return;
      } catch {
        // Verbindung abgebrochen oder Druckfehler: Fallback auf Download
      }
    }

    downloadLabelPng(canvas, data.postid);
  }

  const activeKategorie = verbleib && !isDefault ? verbleib : null;

  const badgeContent = (
    <span className="flex items-center gap-1">
      {activeKategorie ? (
        <>
          <VerbleibIcon name={activeKategorie.icon} className="h-3 w-3 flex-shrink-0" />
          <span className="truncate max-w-[90px]">
            {savedAblage ? savedAblage.name : activeKategorie.name}
          </span>
          {activeKategorie.archived && <span className="text-muted-foreground/50">(veraltet)</span>}
        </>
      ) : urkundeFlag ? null : (
        <span className="text-muted-foreground/50">? Original</span>
      )}
      {urkundeFlag && <ShieldCheck className="h-3 w-3 flex-shrink-0 text-amber-500" />}
    </span>
  );

  if (!canWrite) {
    if (isEmpty) return null;
    return (
      <Badge variant="outline" className="text-xs select-none flex items-center gap-1">
        {badgeContent}
      </Badge>
    );
  }

  // Kategorien aufteilen: aktive zuerst, archivierte ans Ende
  const aktivKategorien = kategorien.filter((k) => !k.archived);
  // Archivierte Kategorien die aktuell vergeben sind, müssen auch angezeigt werden
  const archivedButAssigned = verbleib?.archived ? [verbleib] : [];

  return (
    <span ref={wrapperRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={update.isPending}
        className="inline-flex items-center"
        title="Originalverbleib bearbeiten"
      >
        <Badge
          variant="outline"
          className={[
            'text-xs select-none cursor-pointer flex items-center gap-1 hover:bg-accent transition-colors',
            isEmpty ? 'border-dashed text-muted-foreground/40 hover:text-muted-foreground' : '',
          ].join(' ')}
        >
          {badgeContent}
        </Badge>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border bg-popover shadow-md p-2 space-y-0.5">
          <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider px-1 pb-1">
            Originalverbleib
          </div>

          {aktivKategorien.map((k) => {
            const isSelected = (verbleib?.id ?? null) === k.id && k.id !== 1;
            return (
              <button
                key={k.id}
                type="button"
                onClick={() => handleSelectKategorie(k.id === 1 ? null : k.id)}
                className={[
                  'w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-sm',
                  'hover:bg-accent transition-colors',
                  isSelected ? 'bg-accent font-medium' : '',
                  k.id === 1 ? 'text-muted-foreground' : '',
                ].join(' ')}
              >
                <VerbleibIcon name={k.icon} className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="flex-1">{k.name}</span>
                {isSelected && <X className="h-3 w-3 text-muted-foreground" title="Zurücksetzen" />}
              </button>
            );
          })}

          {archivedButAssigned.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => handleSelectKategorie(null)}
              className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-sm text-muted-foreground/60 hover:bg-accent transition-colors"
            >
              <VerbleibIcon name={k.icon} className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="flex-1 line-through">{k.name} (veraltet)</span>
              <X className="h-3 w-3" title="Zurücksetzen" />
            </button>
          ))}

          {/* Aufbewahrungsort-Combobox (nur bei gesetzter Obergruppe != Unbekannt) */}
          {hasKategorie && (
            <>
              <div className="border-t my-1.5" />
              <div className="px-1 pb-0.5">
                <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider pb-1">
                  Aufbewahrungsort
                </div>
                <div className="relative">
                  {savedAblage && !ortDropdownOpen ? (
                    <div className="flex items-center gap-2 text-sm py-0.5">
                      <span className="flex-1 truncate">{savedAblage.name}</span>
                      <button
                        type="button"
                        onClick={() => { setOrtDropdownOpen(true); setOrtQuery(''); setTimeout(() => ortInputRef.current?.focus(), 10); }}
                        className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                        title="Ändern"
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={handleClearAblage}
                        className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                        title="Entfernen"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        ref={ortInputRef}
                        type="text"
                        value={ortQuery}
                        onChange={(e) => { setOrtQuery(e.target.value); setOrtDropdownOpen(true); }}
                        onFocus={() => setOrtDropdownOpen(true)}
                        onBlur={() => setTimeout(() => setOrtDropdownOpen(false), 150)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { setOrtDropdownOpen(false); setOrtQuery(''); }
                        }}
                        placeholder="Ablage suchen…"
                        className="w-full text-sm bg-transparent border border-border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
                        autoComplete="off"
                      />
                      {ortDropdownOpen && (
                        <div className="absolute left-0 right-0 top-full mt-0.5 z-10 bg-popover border border-border rounded shadow-md max-h-48 overflow-y-auto">
                          {filteredAblagen.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-muted-foreground">
                              {ortQuery ? 'Keine passenden Ablagen' : 'Keine aktiven Ablagen'}
                            </div>
                          ) : (
                            filteredAblagen.map((ablage) => (
                              <button
                                key={ablage.id}
                                type="button"
                                onMouseDown={(e) => { e.preventDefault(); handleSelectAblage(ablage); }}
                                className={[
                                  'w-full text-left flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors',
                                  savedAblage?.id === ablage.id ? 'bg-accent font-medium' : '',
                                ].join(' ')}
                              >
                                {ablage.name}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Niemals aussondern */}
          <div className="border-t my-1.5" />

          <button
            type="button"
            onClick={handleToggleUrkunde}
            className={[
              'w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-sm',
              'hover:bg-accent transition-colors',
              urkundeFlag ? 'bg-accent font-medium' : '',
            ].join(' ')}
          >
            <ShieldCheck className={['h-3.5 w-3.5 flex-shrink-0', urkundeFlag ? 'text-amber-500' : 'text-muted-foreground'].join(' ')} />
            <span className="flex-1">Niemals aussondern</span>
          </button>

          {/* Etikett drucken */}
          <div className="border-t my-1.5" />

          <button
            type="button"
            onClick={handlePrintLabel}
            className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors"
          >
            <Printer className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="flex-1">Etikett drucken</span>
          </button>
        </div>
      )}
    </span>
  );
}
