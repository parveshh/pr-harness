import { UserRound } from 'lucide-react';
import { useState } from 'react';
import type { Bundle, Draft, Edit } from '../../shared/publish.js';
import { readableError } from '../../shared/assistant.js';
import { locationLabel, type DraftEditor } from './DraftReview.js';

export function InlineComments({
  url,
  bundle,
  comments,
  editor,
  setEditor,
  onChange,
  onClose,
}: {
  url: string;
  bundle: Bundle;
  comments: Draft[];
  editor: DraftEditor | null;
  setEditor: (e: DraftEditor) => void;
  onChange: (b: Bundle) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
            <p>{c.body}</p>
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
