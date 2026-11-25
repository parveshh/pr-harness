import type { Token } from '../../../shared/highlight.js';

// Token offsets exclude the leading diff marker.
export function CodeLine({
  text,
  tokens,
  match,
}: {
  text: string;
  tokens: Token[] | null;
  match?: { start: number; end: number } | null;
}) {
  function renderRange(start: number, end: number) {
    if (!tokens) return text.slice(start, end);
    let offset = 1;
    return (
      <>
        {start === 0 && text.slice(0, 1)}
        {tokens.map((token, index) => {
          const from = offset;
          offset += token.text.length;
          if (offset <= start || from >= end) return null;
          const part = text.slice(Math.max(start, from), Math.min(end, offset));
          return token.kind ? (
            <span key={index} className={token.kind}>
              {part}
            </span>
          ) : (
            part
          );
        })}
      </>
    );
  }
  return (
    <span className="code-line">
      {match ? (
        <>
          {renderRange(0, match.start)}
          <mark>{renderRange(match.start, match.end)}</mark>
          {renderRange(match.end, text.length)}
        </>
      ) : (
        renderRange(0, text.length)
      )}
    </span>
  );
}
