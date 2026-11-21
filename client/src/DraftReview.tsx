import { useState } from 'react';
import { ClipboardList, MessageSquarePlus } from 'lucide-react';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import { readableError } from '../../shared/assistant.js';
import type { Bundle, Draft, Edit, CommentAnchor } from '../../shared/publish.js';
import type { ReaderView } from '../../shared/reader.js';

export type DraftEditor = {
  id: string | null;
  target: (CommentAnchor & { revision: string }) | null;
  body: string;
  location: CommentAnchor;
  excerpt: string;
};
const decisions = { COMMENT: 'Comment', APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes' };
export const locationLabel = (a: CommentAnchor) =>
  a.path +
  ':' +
  (a.startLine && a.startLine !== a.line ? a.startLine + '–' + a.line : a.line) +
  ' (' +
  (a.side === 'old' ? 'original' : 'updated') +
  ')';

export function DraftReview({
  url,
  view,
  bundle,
  onChange,
  selection,
}: {
  url: string;
  view: ReaderView;
  bundle: Bundle;
  onChange: (b: Bundle) => void;
  selection: CommentAnchor | null;
}) {
  const [editor, setEditor] = useState<DraftEditor | null>(null);
  const [panel, setPanel] = useState<'closed' | 'review' | 'preview'>('closed');
  const [summary, setSummary] = useState(bundle.summary),
    [event, setEvent] = useState(bundle.event);
  const [actor, setActor] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [preview, setPreview] = useState<{ version: number; revision: string } | null>(null);
  const [notice, setNotice] = useState('');
  function work(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    task()
      .catch(async (e: unknown) => {
        setError(readableError(e));
        try {
          onChange(await window.reviewer.reviewDrafts(url));
        } catch {
          /* Keep local editing state. */
        }
      })
      .finally(() => setBusy(false));
  }
  async function edit(request: Edit) {
    const b = await window.reviewer.editDrafts(url, bundle.version, request);
    onChange(b);
    return b;
  }
  function openReview() {
    setSummary(bundle.summary);
    setEvent(bundle.event);
    setError('');
    setPanel('review');
  }
  function editComment(d: Draft, relocate = false) {
    const target = relocate && selection ? { ...selection, revision: view.revision } : null;
    setError('');
    setEditor({
      id: d.id,
      location: target ?? d,
      target,
      excerpt: target ? '' : d.excerpt,
      body: d.body,
    });
  }
  const stale = bundle.comments.filter((d) => d.revision !== view.revision).length;
  const valid =
    event === 'APPROVE' || !!summary.trim() || (event === 'COMMENT' && bundle.comments.length > 0);
  const reviewing = panel === 'review';
  const locked = !!bundle.pending;
  const closePanel = () => {
    setPanel('closed');
    setError('');
  };
  async function saveDetails() {
    if (summary === bundle.summary && event === bundle.event) return bundle;
    return edit({ action: 'details', summary, event });
  }
  function receipt() {
    work(() => window.reviewer.openReceipt(url));
  }
  return (
    <section className="draft-tools" aria-label="Pull request review">
      <button className="review-drafts" onClick={openReview}>
        <ClipboardList size={15} /> Review drafts <span>{bundle.comments.length}</span>
      </button>
      {stale > 0 && (
        <small>
          {stale} outdated {stale === 1 ? 'draft' : 'drafts'}
        </small>
      )}
      {locked && <small>Submission needs checking</small>}
      {bundle.receipt && (
        <button className="secondary" onClick={receipt}>
          Open published review ↗
        </button>
      )}
      {notice && <small role="status">{notice}</small>}
      {error && !editor && panel === 'closed' && <p role="alert">{error}</p>}
      {editor ? (
        <WorkspaceDialog
          title={editor.id ? 'Edit draft comment' : 'Draft line comment'}
          icon={<MessageSquarePlus size={21} />}
          wide
          busy={busy}
          onClose={() => {
            setEditor(null);
            setError('');
          }}
        >
          <p className="draft-location">{locationLabel(editor.location)}</p>
          {editor.excerpt && <pre className="draft-excerpt">{editor.excerpt}</pre>}
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              work(async () => {
                await edit({
                  action: 'draft',
                  id: editor.id,
                  target: editor.target,
                  body: editor.body,
                });
                setEditor(null);
                setNotice('Draft saved locally.');
              });
            }}
          >
            <label htmlFor="draft-body">Comment</label>
            <textarea
              id="draft-body"
              autoFocus
              rows={5}
              required
              maxLength={60000}
              value={editor.body}
              onChange={(e) => setEditor({ ...editor, body: e.target.value })}
            />
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => {
                  setEditor(null);
                  setError('');
                }}
              >
                Cancel
              </button>
              <button disabled={busy || locked || !editor.body.trim()}>Save draft</button>
            </div>
          </form>
        </WorkspaceDialog>
      ) : (
        panel !== 'closed' && (
          <WorkspaceDialog
            wide
            busy={busy}
            title={
              locked
                ? 'Check review submission'
                : reviewing
                  ? 'Review drafts'
                  : 'Submit review to GitHub?'
            }
            icon={<ClipboardList size={21} />}
            onClose={closePanel}
          >
            {locked ? (
              <>
                <p>
                  The last submission has no local receipt. Check whether GitHub received it as @
                  {bundle.pending?.actor} before reopening these drafts.
                </p>
                <div className="dialog-actions">
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() =>
                      work(async () => {
                        const b = await window.reviewer.reopenDrafts(url, bundle.version);
                        onChange(b);
                        setSummary(b.summary);
                        setEvent(b.event);
                        setPanel(b.receipt !== bundle.receipt ? 'closed' : 'review');
                      })
                    }
                  >
                    I checked the PR · reopen drafts
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      work(async () => {
                        onChange(await window.reviewer.checkSubmission(url));
                        setPanel('closed');
                        setNotice('Published review found.');
                      })
                    }
                  >
                    Check GitHub
                  </button>
                </div>
              </>
            ) : (
              <>
                {!reviewing && (
                  <p>
                    Submitting as <strong>@{actor}</strong> to{' '}
                    <strong>{new URL(url).pathname.slice(1)}</strong> at{' '}
                    <code>{preview?.revision.split('...').at(-1)}</code>.
                  </p>
                )}
                <div className="draft-list">
                  {bundle.comments.map((d) => (
                    <div className="draft-card" key={d.id}>
                      <strong className="draft-location">{locationLabel(d)}</strong>
                      <pre className="draft-excerpt">{d.excerpt}</pre>
                      <div className="draft-body">{d.body}</div>
                      {d.revision !== view.revision && (
                        <p>
                          Outdated draft. Select its current line in the full PR diff to reattach
                          it.
                        </p>
                      )}
                      {reviewing && (
                        <div className="draft-actions">
                          <button onClick={() => editComment(d)} disabled={busy}>
                            Edit
                          </button>
                          {d.revision !== view.revision && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                work(async () => {
                                  const b = await edit({
                                    action: 'to-summary',
                                    id: d.id,
                                    summary,
                                    event,
                                  });
                                  setSummary(b.summary);
                                })
                              }
                            >
                              Move to summary
                            </button>
                          )}
                          {d.revision !== view.revision && selection && (
                            <button disabled={busy} onClick={() => editComment(d, true)}>
                              Use selected line
                            </button>
                          )}
                          <button
                            disabled={busy}
                            onClick={() =>
                              work(async () => {
                                await edit({ action: 'discard', id: d.id });
                              })
                            }
                          >
                            Discard
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {!bundle.comments.length && <p>No inline comments in this review.</p>}
                </div>
                {reviewing ? (
                  <>
                    <label htmlFor="review-summary">Review summary</label>
                    <textarea
                      id="review-summary"
                      rows={3}
                      maxLength={60000}
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                    />
                    <label htmlFor="review-decision">Review decision</label>
                    <select
                      id="review-decision"
                      value={event}
                      onChange={(e) => setEvent(e.target.value as Bundle['event'])}
                    >
                      {Object.entries(decisions).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <div className="dialog-actions">
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          work(async () => {
                            await saveDetails();
                            closePanel();
                            setNotice('Review saved locally.');
                          })
                        }
                      >
                        Save and close
                      </button>
                      <button
                        disabled={busy || stale > 0 || !valid}
                        onClick={() =>
                          work(async () => {
                            const saved = await saveDetails();
                            setActor(await window.reviewer.reviewIdentity());
                            setPreview({ version: saved.version, revision: view.revision });
                            setPanel('preview');
                          })
                        }
                      >
                        Preview submission
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3>{decisions[bundle.event]}</h3>
                    <p className="draft-body">{bundle.summary || 'No summary.'}</p>
                    <small>
                      A hidden tracking ID in the review body lets Local Reviewer recover a lost
                      receipt.
                    </small>
                    <div className="dialog-actions">
                      <button className="quiet" disabled={busy} onClick={openReview}>
                        Back to drafts
                      </button>
                      <button
                        disabled={
                          busy ||
                          !preview ||
                          preview.version !== bundle.version ||
                          preview.revision !== view.revision
                        }
                        onClick={() =>
                          work(async () => {
                            if (!preview) return;
                            const b = await window.reviewer.publishReview({
                              url,
                              ...preview,
                              actor,
                            });
                            onChange(b);
                            setPanel('closed');
                            setNotice('Review submitted to GitHub.');
                          })
                        }
                      >
                        {busy ? 'Submitting…' : 'Submit review to GitHub'}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {error && <p role="alert">{error}</p>}
          </WorkspaceDialog>
        )
      )}
    </section>
  );
}
