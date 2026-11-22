import { useRef, useState } from 'react';
import { readableError, type Turn } from '../../shared/assistant.js';
import { verdict, type Finding } from '../../shared/findings.js';
import type { Bundle, CommentAnchor } from '../../shared/publish.js';

export function ReviewFindings({
  url,
  turn,
  findings,
  current,
  bundle,
  jump,
  onUpdated,
  onDrafts,
}: {
  url: string;
  turn: Turn;
  findings: Finding[];
  current: boolean;
  bundle: Bundle | null;
  jump: (anchor: CommentAnchor) => void;
  onUpdated: (turn: Turn) => void;
  onDrafts: (bundle: Bundle) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const eligible = findings.filter((f) => f.verdict === 'valid' && !f.drafted && f.location);
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(readableError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="review-findings" aria-label="Review findings">
      <h3>
        {findings.length ? `Findings (${findings.length})` : 'No actionable findings reported'}
      </h3>
      {!current && (
        <p>
          These findings refer to an earlier revision. Run Review PR on the current diff to add
          drafts.
        </p>
      )}
      {findings.map((f) => (
        <article key={f.id} aria-label={f.title}>
          <small>{f.priority} priority</small>
          <h4>{f.title}</h4>
          <p>{f.comment}</p>
          {f.location ? (
            <details>
              <summary>
                {f.location.path} · {f.location.side === 'old' ? 'original' : 'updated'}{' '}
                {f.location.startLine
                  ? `lines ${f.location.startLine}–${f.location.line}`
                  : `line ${f.location.line}`}
              </summary>
              <pre>{f.location.excerpt}</pre>
              {current && (
                <button
                  type="button"
                  onClick={() => {
                    if (f.location) jump(f.location);
                  }}
                >
                  Show in diff
                </button>
              )}
            </details>
          ) : (
            <small>No verified inline location</small>
          )}
          {f.drafted ? (
            <small>Added to drafts</small>
          ) : (
            <label>
              Validation
              <select
                aria-label={'Validation for ' + f.title}
                value={f.verdict}
                disabled={!current || busy}
                onChange={(e) => {
                  const next = verdict.parse(e.target.value);
                  void perform(async () =>
                    onUpdated(
                      await window.reviewer.assessFinding({
                        url,
                        run: turn.run,
                        id: f.id,
                        verdict: next,
                      }),
                    ),
                  );
                }}
              >
                <option value="unreviewed">Unreviewed</option>
                <option value="valid">Valid</option>
                <option value="dismissed">Dismissed</option>
              </select>
            </label>
          )}
        </article>
      ))}
      {!!eligible.length && current && (
        <button
          type="button"
          disabled={busy || !bundle || !!bundle.pending}
          onClick={() => {
            if (!bundle) return;
            void perform(async () => {
              const result = await window.reviewer.draftFindings({
                url,
                run: turn.run,
                version: bundle.version,
                ids: eligible.map((f) => f.id),
              });
              onUpdated(result.turn);
              onDrafts(result.bundle);
            });
          }}
        >
          Add {eligible.length} draft {eligible.length === 1 ? 'comment' : 'comments'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
