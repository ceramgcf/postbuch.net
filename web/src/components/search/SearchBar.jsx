import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Sparkles } from 'lucide-react';

export function SearchBar({ onSearch, onSemanticSearch, aktenmodusAkteId, aktenmodusBetreff, aktenmodusBackTo }) {
  const [value, setValue] = useState('');
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();
    if (value.trim()) {
      const params = new URLSearchParams({ q: value.trim() });
      if (aktenmodusAkteId) {
        params.set('aktenmodusAkteId', aktenmodusAkteId);
        if (aktenmodusBetreff) params.set('aktenmodusBetreff', aktenmodusBetreff);
        if (aktenmodusBackTo) params.set('aktenmodusBackTo', aktenmodusBackTo);
      }
      navigate(`/search?${params.toString()}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 flex-1 max-w-xl">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Dokumente durchsuchen..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="pl-9 h-9 bg-muted/50 border-border/60 focus-visible:bg-background"
        />
      </div>
      <Button type="submit" size="sm" disabled={!value.trim()}>
        Suchen
      </Button>
    </form>
  );
}
