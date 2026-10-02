import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * Renders a label/value pair with a clipboard copy button.
 * The copy button only appears when `value` is a non-empty string.
 *
 * Props:
 *   label      – field label (dt text)
 *   value      – the string to display and copy
 *   mono       – if true, the value is rendered in monospace
 *   highlight  – if true, wraps the value in the brush-highlight style
 *   className  – extra class names applied to the outer <div>
 */
export function CopyableField({ label, value, copyValue, mono = false, highlight = false, className = '' }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!value) return;
    navigator.clipboard.writeText(copyValue ?? value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const valueEl = value
    ? highlight
      ? <span className={`highlight font-semibold${mono ? ' font-mono text-xs' : ''}`}>{value}</span>
      : <span className={mono ? 'font-mono text-xs' : ''}>{value}</span>
    : <span className="text-muted-foreground/60">–</span>;

  return (
    <div className={className}>
      <div className="flex items-center gap-1 mb-0.5">
        <dt className="text-muted-foreground">{label}</dt>
        {value && (
          <button
            onClick={handleCopy}
            title={copied ? 'Kopiert!' : `${label} kopieren`}
            className="text-muted-foreground/30 hover:text-muted-foreground transition-colors"
          >
            {copied
              ? <Check className="h-3 w-3 text-green-500" />
              : <Copy className="h-3 w-3" />
            }
          </button>
        )}
      </div>
      <dd className="font-medium">{valueEl}</dd>
    </div>
  );
}
