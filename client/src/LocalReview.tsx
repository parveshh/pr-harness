import { useRef, useState, type FormEvent } from 'react';
import { FolderGit2 } from 'lucide-react';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import { readableError } from '../../shared/assistant.js';
import type { LocalCandidate } from '../../shared/local.js';
import type { SavedReview } from '../../shared/reviews.js';

// Choose a local clone, pick the branch to compare with, and start a read-only review.
export function LocalReviewStart({
  disabled,
  savedPath,
  onStarted,
}: {
  disabled: boolean;
  savedPath?: string;
  onStarted: (url: string, reviews: SavedReview[]) => void;
}) {
  const [candidate, setCandidate] = useState<LocalCandidate | null>(null);
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  function choose() {
    if (busy) return;
    setBusy(true);
    setError('');
    window.reviewer
      .chooseLocalRepository(savedPath)
      .then((chosen) => {
        if (!chosen) return;
        setCandidate(chosen);
        setBase(chosen.defaultBase ?? chosen.bases[0]?.ref ?? '');
      })
      .catch((e: unknown) => setError(readableError(e)))
      .finally(() => setBusy(false));
  }
  function close() {
    setCandidate(null);
    setError('');
    requestAnimationFrame(() => trigger.current?.focus());
  }
  function start(event: FormEvent) {
    event.preventDefault();
    if (!candidate || busy || !base) return;
    setBusy(true);
    setError('');
    window.reviewer
      .startLocalReview(candidate.id, base)
      .then((started) => {
        setCandidate(null);
        onStarted(started.url, started.reviews);
      })
      .catch((e: unknown) => setError(readableError(e)))
      .finally(() => setBusy(false));
  }
  return (
    <div className="local-entry">
      <button
        ref={trigger}
        type="button"
        className="secondary"
        disabled={disabled || busy}
        onClick={choose}
      >
        <FolderGit2 size={16} aria-hidden /> Review local branch
      </button>
      {savedPath ? (
        <small>{savedPath}</small>
      ) : (
        <small>Read a coding agent’s work in a local clone before it becomes a pull request.</small>
      )}
      {error && !candidate && <p role="alert">{error}</p>}
      {candidate && (
        <WorkspaceDialog
          title="Review local branch"
          icon={<FolderGit2 size={20} />}
          wide
          busy={busy}
          onClose={close}
        >
          <dl className="local-repo">
            <dt>Repository</dt>
            <dd>{candidate.repository}</dd>
            <dt>Folder</dt>
            <dd>
              <code>{candidate.path}</code>
            </dd>
            <dt>Current branch</dt>
            <dd>
              <code>{candidate.branch ?? 'Detached HEAD at ' + candidate.head.slice(0, 8)}</code>
            </dd>
          </dl>
          <form className="dialog-form" onSubmit={start}>
            <label htmlFor="local-base">Base branch</label>
            <select
              id="local-base"
              value={base}
              disabled={busy}
              onChange={(e) => setBase(e.target.value)}
              required
            >
              {candidate.bases.map((option) => (
                <option key={option.ref} value={option.ref}>
                  {option.name}
                </option>
              ))}
            </select>
            <p>
              The review compares the merge base with this branch against the working tree,
              including staged, unstaged and untracked files. Local Reviewer only reads the
              repository.
            </p>
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="quiet" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button disabled={busy || !base}>{busy ? 'Reading changes…' : 'Start review'}</button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </div>
  );
}
