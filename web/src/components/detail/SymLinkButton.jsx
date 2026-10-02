import { useState } from 'react';
import { Link2, Check } from 'lucide-react';

// Kleiner Button, der ein SymLink-Token in die Zwischenablage kopiert.
// Zeigt kurz ein Häkchen als Bestätigung. Nur Icon (kompakt, für Listen/Tabellen).
export function SymLinkButton({ token, title = 'SymLink kopieren', className = '' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      // Fallback für Kontexte ohne Clipboard-API
      const ta = document.createElement('textarea');
      ta.value = token;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Kopiert!' : `${title} (${token})`}
      className={`text-muted-foreground/40 hover:text-primary transition-colors ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Link2 className="h-3.5 w-3.5" />}
    </button>
  );
}
