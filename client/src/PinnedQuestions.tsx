import { useEffect, useState, type FormEvent } from 'react';
import { Pin } from 'lucide-react';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import { readableError } from '../../shared/assistant.js';
import type { PinnedQuestion, QuestionEvidence } from '../../shared/questions.js';
import { shortRevision } from '../../shared/reader.js';

export type QuestionPanel =
  | { kind: 'new'; id: string; revision: string; path: string; hunk: number }
  | { kind: 'list' }
  | { kind: 'inspect'; id: string };
const statusLabels: Record<PinnedQuestion['status'], string> = {
  pinned: 'Pinned here',
  unchanged: 'Hunk unchanged',
  moved: 'Hunk moved',
  changed: 'Hunk changed',
  missing: 'File left the PR diff',
  ambiguous: 'Multiple possible locations',
  unavailable: 'Incomplete evidence',
  unmatched: 'Hunk could not be located',
};
const shortHead = (revision: string) => shortRevision(revision);
const location = (anchor: { path: string; hunk: number }) =>
  anchor.path + ' · hunk ' + (anchor.hunk + 1);

export function QuestionLinks({
  questions,
  inspect,
}: {
  questions: PinnedQuestion[];
  inspect: (id: string) => void;
}) {
  if (!questions.length) return null;
  return (
    <div className="hunk-questions" aria-label="Open pinned questions">
      {questions.map((q) => (
        <button className="question-link" key={q.id} onClick={() => inspect(q.id)}>
          <Pin size={13} />
          <span>{q.question}</span>
        </button>
      ))}
    </div>
  );
}

function List({
  questions,
  inspect,
}: {
  questions: PinnedQuestion[];
  inspect: (id: string) => void;
}) {
  return (
    <div className="question-list">
      {questions.map((q) => (
        <button className="question-item" key={q.id} onClick={() => inspect(q.id)}>
          <strong>{q.question}</strong>
          <small>
            {location(q.current ?? q.origin)} · {statusLabels[q.status]}
          </small>
        </button>
      ))}
    </div>
  );
}

// Show the area between the first and last edited lines with nearby context.
// The two excerpts retain their original PR diff markers.
function excerpts(before: string, after: string) {
  const [oldHeader = '', ...left] = before.split('\n'),
    [newHeader = '', ...right] = after.split('\n');
  let prefix = 0,
    suffix = 0;
  const common = Math.min(left.length, right.length);
  while (prefix < common && left[prefix] === right[prefix]) prefix++;
  while (
    suffix < common - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const start = Math.max(0, prefix - 3),
    trim = Math.max(0, suffix - 3);
  function part(header: string, rows: string[]) {
    return [
      header,
      ...(start ? ['…'] : []),
      ...rows.slice(start, rows.length - trim),
      ...(trim ? ['…'] : []),
    ].join('\n');
  }
  return { before: part(oldHeader, left), after: part(newHeader, right) };
}
function Evidence({ url, revision, pin }: { url: string; revision: string; pin: PinnedQuestion }) {
  const [data, setData] = useState<QuestionEvidence | null>(null);
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  useEffect(() => {
    let live = true;
    window.reviewer
      .questionEvidence({ url, revision, id: pin.id })
      .then((e) => {
        if (live) setData(e);
      })
      .catch((e) => {
        if (live) setError(readableError(e));
      });
    return () => {
      live = false;
    };
  }, [url, revision, pin.id, pin.status]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p role="status">Loading hunk evidence…</p>;
  const changes =
    pin.status === 'changed' && data.current ? excerpts(data.original, data.current) : null;
  return (
    <div className="pin-evidence">
      {changes && (
        <label>
          <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> Show
          entire hunks
        </label>
      )}
      <h3>Pinned hunk · {shortHead(pin.origin.revision)}</h3>
      <small>
        {location(pin.origin)}
        {data.originalPartial ? ' · partial diff' : ''}
      </small>
      <pre>{!full && changes ? changes.before : data.original}</pre>
      {(pin.origin.revision !== revision || pin.status !== 'pinned') && (
        <>
          <h3>Current hunk · {shortHead(revision)}</h3>
          {pin.current && <small>{location(pin.current)}</small>}
          {data.current === null ? (
            <p>{statusLabels[pin.status]}. The original evidence is saved above.</p>
          ) : pin.status === 'unchanged' ? (
            <p>The hunk still matches the pinned evidence.</p>
          ) : (
            <pre>{!full && changes ? changes.after : data.current}</pre>
          )}
        </>
      )}
    </div>
  );
}

export function PinnedQuestions({
  url,
  revision,
  panel,
  questions,
  show,
  close,
  onChange,
  jump,
}: {
  url: string;
  revision: string;
  panel: QuestionPanel;
  questions: PinnedQuestion[];
  show: (panel: QuestionPanel) => void;
  close: () => void;
  onChange: (questions: PinnedQuestion[]) => void;
  jump: (path: string, hunk: number | null) => void;
}) {
  const [question, setQuestion] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pin = panel.kind === 'inspect' ? questions.find((q) => q.id === panel.id) : undefined;
  const open = questions.filter((q) => !q.addressed),
    addressed = questions.filter((q) => q.addressed);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (panel.kind !== 'new' || !question.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await window.reviewer.pinQuestion({
        url,
        revision: panel.revision,
        path: panel.path,
        hunk: panel.hunk,
        id: panel.id,
        question,
      });
      onChange(saved);
      close();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  async function address() {
    if (!pin || busy) return;
    setBusy(true);
    setError('');
    try {
      onChange(
        await window.reviewer.addressQuestion({ url, revision, id: pin.id }, !pin.addressed),
      );
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  const inspect = (id: string) => show({ kind: 'inspect', id });
  return (
    <WorkspaceDialog
      title={
        panel.kind === 'new'
          ? 'Pin a question'
          : panel.kind === 'list'
            ? 'Pinned questions'
            : 'Pinned question'
      }
      icon={<Pin size={22} />}
      wide
      onClose={close}
      busy={busy}
    >
      {panel.kind === 'new' ? (
        <form className="dialog-form" onSubmit={(e) => void save(e)}>
          <small>
            {location(panel)} · {shortHead(panel.revision)}
          </small>
          <label htmlFor="pin-question">Question</label>
          <textarea
            id="pin-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            maxLength={4000}
            required
            autoFocus
          />
          <div className="dialog-actions">
            <button disabled={busy || !question.trim()}>Save pinned question</button>
          </div>
        </form>
      ) : panel.kind === 'list' ? (
        <>
          <h3>Open · {open.length}</h3>
          {open.length ? <List questions={open} inspect={inspect} /> : <p>No open questions.</p>}
          {addressed.length > 0 && (
            <details>
              <summary>Addressed · {addressed.length}</summary>
              <List questions={addressed} inspect={inspect} />
            </details>
          )}
        </>
      ) : (
        pin && (
          <>
            <h3 className="pin-title">{pin.question}</h3>
            <small>
              {pin.addressed ? 'Addressed' : 'Open'} · {statusLabels[pin.status]}
            </small>
            <Evidence key={pin.id + revision} url={url} revision={revision} pin={pin} />
            <div className="dialog-actions">
              <button className="quiet" onClick={() => show({ kind: 'list' })}>
                All questions
              </button>
              {pin.filePath && (
                <button
                  className="quiet"
                  onClick={() => {
                    if (pin.filePath) jump(pin.filePath, pin.current?.hunk ?? null);
                  }}
                >
                  {pin.current ? 'Open hunk' : 'Inspect current file'}
                </button>
              )}
              <button disabled={busy} onClick={() => void address()}>
                {pin.addressed ? 'Reopen question' : 'Mark addressed'}
              </button>
            </div>
          </>
        )
      )}
      {error && <p role="alert">{error}</p>}
    </WorkspaceDialog>
  );
}
