import { UserRound } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Bundle, Draft, Edit } from '../../shared/publish.js';
import { readableError } from '../../shared/assistant.js';
import { locationLabel, type DraftEditor } from './DraftReview.js';
import { DraftBody, SuggestChangeButton } from './components/SuggestedChange.js';
import { newSideLines } from '../../shared/suggestions.js';

export function InlineComments({
  url,
  bundle,
  comments,
  hunk,
  editor,
  setEditor,
  onChange,
  onClose,
}: {
  url: string;
  bundle: Bundle;
  comments: Draft[];
  // The diff hunk these comments sit in, for the new-side text of a suggestion.
  hunk: string;
  editor: DraftEditor | null;
  setEditor: (e: DraftEditor) => void;
  onChange: (b: Bundle) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  async function edit(request: Edit) {
    setBusy(true);
    setError('');
    try {
      onChange(await window.reviewer.editDrafts(url, bundle.version, request));
      if (request.action === 'draft') onClose();
    } catch (e) {
      setError(readableError(e));
      try {
        onChange(await window.reviewer.reviewDrafts(url));
      } catch {
        /* Keep the text for retry. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="inline-comments" aria-label="Line comments">
      {comments
        .filter((c) => c.id !== editor?.id)
        .map((c) => (
          <div className="inline-note" key={c.id}>
            <div className="draft-byline">
              <UserRound size={14} />
              <strong>You</strong>
              <small title={locationLabel(c)}>Draft · Local</small>
            </div>
            <DraftBody draft={c} />
            <div>
              <button
                disabled={busy || !!bundle.pending}
                onClick={() =>
                  setEditor({
                    id: c.id,
                    target: null,
                    location: c,
                    excerpt: c.excerpt,
                    body: c.body,
                  })
                }
              >
                Edit
              </button>
              <button
                disabled={busy || !!bundle.pending}
                onClick={() => void edit({ action: 'discard', id: c.id })}
              >
                Discard
              </button>
            </div>
          </div>
        ))}
      {editor && (
        <form
          className="inline-composer"
          aria-label="Draft line comment"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && editor.body.trim())
              void edit({
                action: 'draft',
                id: editor.id,
                target: editor.target,
                body: editor.body,
              });
          }}
        >
          <label htmlFor="inline-comment-body">
            Comment
            <textarea
              id="inline-comment-body"
              ref={field}
              aria-label="Comment"
              autoFocus
              rows={3}
              maxLength={60000}
              value={editor.body}
              onChange={(e) => setEditor({ ...editor, body: e.target.value })}
              placeholder="Write a review comment…"
            />
          </label>
          <footer>
            <small>{locationLabel(editor.location)}</small>
            <SuggestChangeButton
              side={editor.location.side}
              source={newSideLines(hunk, editor.location)}
              unavailable="The commented lines are not shown in this hunk."
              body={editor.body}
              textarea={field}
              onBody={(body) => setEditor({ ...editor, body })}
            />
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button disabled={busy || !!bundle.pending || !editor.body.trim()}>Save draft</button>
          </footer>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
