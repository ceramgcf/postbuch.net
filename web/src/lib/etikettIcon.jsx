import { renderToStaticMarkup } from 'react-dom/server';
import * as LucideIcons from 'lucide-react';

/**
 * Lucide-Symbol als schwarzes SVG-Markup für den Etikettendruck
 * (labelRenderer.js zeichnet es auf die Leinwand). Unbekannte Namen → Fragezeichen.
 */
export function etikettIconSvg(name, { strokeWidth = 2.5 } = {}) {
  const Icon = LucideIcons[name] ?? LucideIcons.FileQuestionMark;
  return renderToStaticMarkup(<Icon size={64} color="#000" strokeWidth={strokeWidth} />);
}
