import type { Token } from '../../../shared/highlight.js';

// Renders one diff row. `text` starts with the diff marker. `tokens` cover the rest of the
// line, or are null when the row is shown without syntax colours.
export function CodeLine({ text, tokens }: { text: string; tokens: Token[] | null }) {
  return (
    <span className="code-line">
      {tokens ? (
        <>
          {text.slice(0, 1)}
          {tokens.map((token, index) =>
            token.kind ? (
              <span key={index} className={token.kind}>
                {token.text}
              </span>
            ) : (
              token.text
            ),
          )}
        </>
      ) : (
        text
      )}
    </span>
  );
}
