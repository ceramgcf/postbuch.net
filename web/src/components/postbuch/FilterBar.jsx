import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';
import { X, ChevronLeft, Tag, CircleDot, User, CalendarDays, Mails, FolderArchive, ShieldCheck } from 'lucide-react';
import { useVerbleibKategorien } from '@/hooks/useVerbleib';
import { useVerbleibAblagen } from '@/hooks/useVerbleibAblagen';
import { TaxonomyBadgeSelect } from './TaxonomyBadgeSelect';

// Filterwert für Dokumente ohne Personenzuordnung (Kurznamen beginnen nie mit _).
const PERSON_OHNE = '_ohne';

const STATUS_DISPLAY = [
  { value: 'AIClearance', label: 'AI \u2713' },
  { value: 'UserClearance', label: 'User \u2713' },
  { value: 'NeedsUserReview', label: 'Review n\u00f6tig' },
];

function Section({ label, icon: Icon, children, active }) {
  return (
    <div className="space-y-2">
      <div className={cn('flex items-center gap-1.5', active ? 'text-primary' : 'text-muted-foreground')}>
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      {children}
    </div>
  );
}

export function FilterBar({ filters, onChange, onClose, showHistorisch }) {
  const { data: katData } = useVerbleibKategorien();
  const kategorien = katData?.data ?? [];
  const hasKategorieFilter = !!filters.verbleib_kategorie_id;
  const { data: ablagenData } = useVerbleibAblagen(
    { kategorie_id: filters.verbleib_kategorie_id, archived: 'false' },
    { enabled: hasKategorieFilter }
  );
  const ablagen = ablagenData?.data ?? [];

  const update = (key, value) => {
    if (key === 'person') {
      if (!value) {
        onChange({
          ...filters,
          person: undefined,
          person_as_adressat: undefined,
          person_as_patient: undefined,
          offset: 0,
        });
        return;
      }
      onChange({
        ...filters,
        person: value,
        person_as_adressat: filters.person_as_adressat ?? 'true',
        person_as_patient: filters.person_as_patient ?? 'false',
        offset: 0,
      });
      return;
    }
    onChange({ ...filters, [key]: value || undefined, offset: 0 });
  };

  const updatePersonRole = (key, checked) => {
    onChange({ ...filters, [key]: checked ? 'true' : 'false', offset: 0 });
  };

  const { data: personenData } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: taxonomieData } = useQuery({
    queryKey: ['taxonomie'],
    queryFn: () => api.taxonomie.get(),
    staleTime: 5 * 60 * 1000,
  });
  const lebensbereiche = (taxonomieData?.lebensbereich || []).filter((x) => x.aktiv);
  const dokumentarten = (taxonomieData?.dokumentart || []).filter((x) => x.aktiv);
  const personOptions = (personenData?.data || []).map((p) => p.kurzname);
  // Nur eigene Dokumente: Die Liste enthält ohnehin nur die eigene Person.
  const { istEingeschraenkt } = useAuth();
  const showPersonFilter = personOptions.length > 0 && !istEingeschraenkt;
  // „(ohne)“ filtert Dokumente ohne Personenzuordnung; die Rollen gelten dann nicht.
  const ohnePerson = filters.person === PERSON_OHNE;
  const hasPerson = !!filters.person && !ohnePerson;
  const personAsAdressat = hasPerson ? filters.person_as_adressat !== 'false' : true;
  const personAsPatient = hasPerson ? filters.person_as_patient === 'true' : false;

  const clear = () => {
    onChange({ sort: 'briefdatum', order: 'desc', limit: 50, offset: 0 });
  };

  const activeCount = [
    filters.lebensbereich,
    filters.dokumentart,
    filters.status,
    filters.person,
    filters.richtung,
    filters.von || filters.bis,
    filters.unbezahlt,
    filters.mit_notiz,
    filters.in_akte,
    filters.offene_wiedervorlage,
    filters.fehlt_in_ablage,
    filters.historisch === 'only',
    filters.verbleib_kategorie_id,
    filters.verbleib_ablage_id,
    filters.original_urkunde,
  ].filter(Boolean).length;

  // Richtungs-Checkboxen: kein Filter-Param → beide aktiv (Default)
  const eingangChecked = filters.richtung !== 'ausgang';
  const ausgangChecked = filters.richtung !== 'eingang';
  const updateRichtung = (which, checked) => {
    const nextEingang = which === 'eingang' ? checked : eingangChecked;
    const nextAusgang = which === 'ausgang' ? checked : ausgangChecked;
    let next;
    if (nextEingang && !nextAusgang) next = 'eingang';
    else if (!nextEingang && nextAusgang) next = 'ausgang';
    else next = undefined;
    onChange({ ...filters, richtung: next, offset: 0 });
  };

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border/60 sticky top-0 bg-sidebar z-10">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Filter</span>
          {activeCount > 0 && (
            <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
              {activeCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <X className="h-3 w-3 mr-1" />
              Zurücksetzen
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              title="Filter ausblenden"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Sections */}
      <div className="flex-1 p-4 space-y-5">

        <Section label="Lebensbereich" icon={FolderArchive} active={!!filters.lebensbereich}>
          <TaxonomyBadgeSelect
            kind="lebensbereich"
            value={filters.lebensbereich || ''}
            onChange={(value) => update('lebensbereich', value)}
            options={lebensbereiche}
            placeholder="Alle Lebensbereiche"
          />
        </Section>

        <Section label="Dokumentart (L×D)" icon={Tag} active={!!filters.dokumentart}>
          <TaxonomyBadgeSelect
            kind="dokumentart"
            value={filters.dokumentart || ''}
            onChange={(value) => update('dokumentart', value)}
            options={dokumentarten}
            placeholder="Alle Dokumentarten"
          />
        </Section>

        {/* Trennlinie */}
        <div className="border-t" />

        {/* Richtung */}
        <Section label="Richtung" icon={Mails} active={!!filters.richtung}>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={eingangChecked}
                onChange={(e) => updateRichtung('eingang', e.target.checked)}
                className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
              />
              <span>Eingangspost</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ausgangChecked}
                onChange={(e) => updateRichtung('ausgang', e.target.checked)}
                className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
              />
              <span>Ausgangspost</span>
            </label>
          </div>
        </Section>

        {/* Trennlinie */}
        <div className="border-t" />

        {/* Status */}
        <Section label="Status" icon={CircleDot} active={!!filters.status}>
          <Select
            value={filters.status || ''}
            onChange={(e) => update('status', e.target.value)}
            className={cn(filters.status && 'border-primary/60 bg-primary/5 text-primary font-medium')}
          >
            <option value="">Alle Status</option>
            {STATUS_DISPLAY.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </Section>

        {/* Trennlinie */}
        <div className="border-t" />

        {/* Person */}
        {showPersonFilter && (
          <>
            <Section label="Person" icon={User} active={!!filters.person}>
              <Select
                value={filters.person || ''}
                onChange={(e) => update('person', e.target.value)}
                className={cn(filters.person && 'border-primary/60 bg-primary/5 text-primary font-medium')}
              >
                <option value="">Alle Personen</option>
                {personOptions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
                <option value={PERSON_OHNE}>(ohne)</option>
              </Select>
              <div className="pt-1 space-y-2">
                <label
                  className={cn(
                    'flex items-center gap-2 text-sm',
                    hasPerson ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={personAsAdressat}
                    disabled={!hasPerson}
                    onChange={(e) => updatePersonRole('person_as_adressat', e.target.checked)}
                    className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
                  />
                  <span>als Adressat/Absender</span>
                </label>
                <label
                  className={cn(
                    'flex items-center gap-2 text-sm',
                    hasPerson ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={personAsPatient}
                    disabled={!hasPerson}
                    onChange={(e) => updatePersonRole('person_as_patient', e.target.checked)}
                    className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
                  />
                  <span>als Patient</span>
                </label>
              </div>
            </Section>

            {/* Trennlinie */}
            <div className="border-t" />
          </>
        )}

        {/* Zeitraum */}
        <Section label="Zeitraum" icon={CalendarDays} active={!!(filters.von || filters.bis)}>
          <div className="space-y-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Von</p>
              <Input
                type="date"
                value={filters.von || ''}
                onChange={(e) => update('von', e.target.value)}
                className={cn(filters.von && 'border-primary/60 bg-primary/5')}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Bis</p>
              <Input
                type="date"
                value={filters.bis || ''}
                onChange={(e) => update('bis', e.target.value)}
                className={cn(filters.bis && 'border-primary/60 bg-primary/5')}
              />
            </div>
          </div>
        </Section>

        {/* Trennlinie */}
        <div className="border-t" />

        {/* Unbezahlt */}
        <label
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
            filters.unbezahlt === 'true'
              ? 'border-primary/60 bg-primary/5 text-primary'
              : 'border-input hover:bg-muted/50 text-muted-foreground hover:text-foreground',
          )}
        >
          <input
            type="checkbox"
            checked={filters.unbezahlt === 'true'}
            onChange={(e) => update('unbezahlt', e.target.checked ? 'true' : undefined)}
            className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
          />
          <span className="text-sm font-medium">Nur unbezahlte</span>
        </label>

        {/* Nur historische: only visible when historisch toggle is on */}
        {showHistorisch && (
          <label
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
              filters.historisch === 'only'
                ? 'border-primary/60 bg-primary/5 text-primary'
                : 'border-input hover:bg-muted/50 text-muted-foreground hover:text-foreground',
            )}
          >
            <input
              type="checkbox"
              checked={filters.historisch === 'only'}
              onChange={(e) => update('historisch', e.target.checked ? 'only' : undefined)}
              className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
            />
            <span className="text-sm font-medium">Nur historische</span>
          </label>
        )}

        <label
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
            filters.mit_notiz === 'true'
              ? 'border-primary/60 bg-primary/5 text-primary'
              : 'border-input hover:bg-muted/50 text-muted-foreground hover:text-foreground',
          )}
        >
          <input
            type="checkbox"
            checked={filters.mit_notiz === 'true'}
            onChange={(e) => update('mit_notiz', e.target.checked ? 'true' : undefined)}
            className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
          />
          <span className="text-sm font-medium">Nur mit Notiz</span>
        </label>

        <label
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
            filters.in_akte === 'true'
              ? 'border-primary/60 bg-primary/5 text-primary'
              : 'border-input hover:bg-muted/50 text-muted-foreground hover:text-foreground',
          )}
        >
          <input
            type="checkbox"
            checked={filters.in_akte === 'true'}
            onChange={(e) => update('in_akte', e.target.checked ? 'true' : undefined)}
            className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
          />
          <span className="text-sm font-medium">Nur wenn Teil einer Akte</span>
        </label>

        <label
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
            filters.offene_wiedervorlage === 'true'
              ? 'border-primary/60 bg-primary/5 text-primary'
              : 'border-input hover:bg-muted/50 text-muted-foreground hover:text-foreground',
          )}
        >
          <input
            type="checkbox"
            checked={filters.offene_wiedervorlage === 'true'}
            onChange={(e) => update('offene_wiedervorlage', e.target.checked ? 'true' : undefined)}
            className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
          />
          <span className="text-sm font-medium">Nur offene Wiedervorlagen</span>
        </label>

        <label
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
            filters.fehlt_in_ablage === 'true'
              ? 'border-primary/60 bg-primary/5 text-primary'
              : 'border-input hover:bg-muted/50 text-muted-foreground hover:text-foreground',
          )}
        >
          <input
            type="checkbox"
            checked={filters.fehlt_in_ablage === 'true'}
            onChange={(e) => update('fehlt_in_ablage', e.target.checked ? 'true' : undefined)}
            className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
          />
          <span className="text-sm font-medium">Nur wenn Datei in der Dateiablage fehlt</span>
        </label>

        {/* Trennlinie */}
        <div className="border-t" />

        {/* Verbleib / Ablage – für eingeschränkte Konten gesperrt */}
        {!istEingeschraenkt && <Section
          label="Verbleib"
          icon={FolderArchive}
          active={!!(filters.verbleib_kategorie_id || filters.verbleib_ablage_id || filters.original_urkunde)}
        >
          <Select
            value={filters.verbleib_kategorie_id || ''}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ ...filters, verbleib_kategorie_id: v || undefined, verbleib_ablage_id: undefined, offset: 0 });
            }}
            className={cn(filters.verbleib_kategorie_id && 'border-primary/60 bg-primary/5 text-primary font-medium')}
          >
            <option value="">Alle Verbleib-Kategorien</option>
            {kategorien.filter((k) => k.id !== 1).map((k) => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </Select>
          {hasKategorieFilter && (
            <Select
              value={filters.verbleib_ablage_id || ''}
              onChange={(e) => update('verbleib_ablage_id', e.target.value)}
              className={cn(filters.verbleib_ablage_id && 'border-primary/60 bg-primary/5 text-primary font-medium')}
            >
              <option value="">Alle Ablagen dieser Kategorie</option>
              {ablagen.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          )}
          <label
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
              filters.original_urkunde === 'true'
                ? 'border-amber-500/60 bg-amber-500/5 text-amber-600'
                : 'border-input hover:bg-muted/50 text-muted-foreground hover:text-foreground',
            )}
          >
            <input
              type="checkbox"
              checked={filters.original_urkunde === 'true'}
              onChange={(e) => update('original_urkunde', e.target.checked ? 'true' : undefined)}
              className="rounded border-input accent-primary h-4 w-4 flex-shrink-0"
            />
            <ShieldCheck className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm font-medium">Nur Urkunden</span>
          </label>
        </Section>}

      </div>
    </div>
  );
}
