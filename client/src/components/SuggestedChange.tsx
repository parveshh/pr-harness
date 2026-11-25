import { useId, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Lightbulb } from 'lucide-react';
import type { Draft } from '../../../shared/publish.js';
import { appendSuggestion, excerptSource, parseBody } from '../../../shared/suggestions.js';

const maxBody = 60000;

// The original lines and the proposed replacement, as text. Labels carry the meaning so it
// does not depend on colour.
export function SuggestionDiff({ before, after }: { before: string[]; after: string[] }) {
  const id = useId();
  return (
    <figure className="suggestion" aria-labelledby={id}>
      <figcaption id={id}>Suggested change</figcaption>
      <div className="suggestion-side" data-kind="before">
        <span>Original</span>
        <pre>{before.join('\n')}</pre>
      </div>
      <div className="suggestion-side" data-kind="after">
        <span>Replacement</span>
        <pre>{after.length ? after.join('\n') : '(delete these lines)'}</pre>
      </div>
    </figure>
  );
}

// A saved comment. Suggestion fences become before/after blocks, other text stays plain.
export function DraftBody({ draft }: { draft: Pick<Draft, 'body' | 'excerpt' | 'side'> }) {
  return (
    <>
      {parseBody(draft.body).map((segment, i) =>
        segment.kind === 'text' ? (
          <p className="draft-prose" key={i}>
            {segment.text}
          </p>
        ) : (
          <div key={i}>
            <SuggestionDiff before={excerptSource(draft.excerpt)} after={segment.lines} />
            {draft.side === 'old' && (
              <p role="note" className="suggestion-warning">
                GitHub only applies suggestions to updated lines, so it will not accept this one.
              </p>
            )}
          </div>
        ),
      )}
    </>
  );
}

// Inserts a suggestion fence holding the current new-side text of the commented lines.
export function SuggestChangeButton({
  side,
  source,
  unavailable,
  body,
  textarea,
  onBody,
}: {
  side: 'old' | 'new';
  // The new-side source of the commented lines, or null when it is not known here.
  source: string[] | null;
  unavailable: string;
  body: string;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onBody: (body: string) => void;
}) {
  const next = side === 'new' && source ? appendSuggestion(body, source) : null;
  const reason =
    side === 'old'
      ? 'GitHub only applies suggestions to new lines. Comment on the updated side to suggest a change.'
      : !source
        ? unavailable
        : next && next.body.length > maxBody
          ? 'The comment is too long to add this suggestion.'
          : undefined;
  return (
    <button
      type="button"
      className="suggest-change quiet"
      disabled={!!reason}
      title={reason ?? 'Insert the commented lines as a suggested change'}
      onClick={() => {
        if (!next) return;
        // Commit the new text before placing the caret inside the fence.
        flushSync(() => onBody(next.body));
        const field = textarea.current;
        field?.focus();
        field?.setSelectionRange(next.caret, next.caret);
      }}
    >
      <Lightbulb size={13} aria-hidden /> Suggest change
    </button>
  );
}
