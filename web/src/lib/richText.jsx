/**
 * richText.jsx – Shared helper for [[[Pxxxxxx]]] / [[[Axxxxxx]]] inline-link rendering.
 *
 * Usage in JSX:   renderRichText(text, navigate, fromPath)
 * Usage in MD:    preprocessRichText(text)  → converts to markdown links
 */

const RICH_PATTERN = /(\[\[\[[PA]\d{6}\]\]\])/g;

/**
 * Splits text by [[[Pxxxxxx]]] / [[[Axxxxxx]]] tokens and returns a React node array
 * where each token is rendered as a clickable router link.
 *
 * @param {string} text
 * @param {function} navigate  - from useNavigate()
 * @param {string}  [fromPath] - optional "from" route for back-navigation state
 * @returns {string | React.ReactNode[]}
 */
export function renderRichText(text, navigate, fromPath) {
  if (!text || !RICH_PATTERN.test(text)) return text;
  RICH_PATTERN.lastIndex = 0;
  const parts = text.split(RICH_PATTERN);
  return parts.map((part, i) => {
    const m = part.match(/^\[\[\[([PA])(\d{6})\]\]\]$/);
    if (!m) return part;
    const docId = m[1] + m[2];
    const path = m[1] === 'P' ? `/postbuch/${docId}` : `/akten/${docId}`;
    return (
      <span
        key={i}
        className="text-primary cursor-pointer hover:underline font-mono text-[0.8em]"
        onClick={(e) => {
          e.stopPropagation();
          navigate(path, fromPath ? { state: { from: fromPath } } : undefined);
        }}
      >
        {docId}
      </span>
    );
  });
}

/**
 * Pre-processes a markdown string by converting [[[Pxxxxxx]]] / [[[Axxxxxx]]] tokens
 * into standard markdown links so ReactMarkdown can render them.
 *
 * @param {string} text
 * @returns {string}
 */
export function preprocessRichText(text) {
  if (!text) return text;
  return text.replace(/\[\[\[([PA])(\d{6})\]\]\]/g, (_match, type, num) => {
    const docId = type + num;
    const path = type === 'P' ? `/postbuch/${docId}` : `/akten/${docId}`;
    return `[${docId}](${path})`;
  });
}
