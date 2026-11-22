import { useEffect, useRef, useState } from 'react';
import { GitCompareArrows } from 'lucide-react';
import { readableError } from '../../shared/assistant.js';
import type {
  Candidate,
  Excerpt,
  PairAnalysis,
  PairPin,
  PairRequest,
  PairSummary,
} from '../../shared/cross-pr.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import './cross-pr.css';

export function CrossPrComparison({ repo, close }: { repo: string; close: () => void }) {
  const [pulls, setPulls] = useState<Candidate[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [request, setRequest] = useState<PairRequest | null>(null);
  useEffect(() => {
    let current = true;
    const run = crypto.randomUUID();
    window.reviewer
      .comparisonCandidates(repo, run)
      .then((pulls) => {
        if (current) setPulls(pulls);
      })
      .catch((e: unknown) => {
        if (current) setError(readableError(e));
      });
    return () => {
      current = false;
      void window.reviewer.cancelCandidateScan(run).catch(() => {
        /* Window shutdown also cancels discovery. */
      });
    };
  }, [repo, attempt]);
  const first = pulls?.find((p) => String(p.number) === left);
  const others =
    pulls?.filter((p) => p.number !== first?.number && p.baseBranch === first?.baseBranch) ?? [];
  const valid = !!first && others.some((p) => String(p.number) === right);
  function refreshList() {
    setPulls(null);
    setError('');
    setRequest(null);
    setAttempt((n) => n + 1);
  }
  return (
    <WorkspaceDialog
      wide
      icon={<GitCompareArrows size={20} />}
      title="Compare pull requests"
      onClose={close}
    >
      <div className="pair-comparison">
        <div className="pair-toolbar">
          <strong>{repo}</strong>
          <button className="secondary" onClick={refreshList} disabled={!pulls && !error}>
            Refresh PR list
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!pulls && !error && <p role="status">Loading open pull requests…</p>}
        {pulls && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (valid)
                  setRequest({
                    run: crypto.randomUUID(),
                    repo,
                    left: Number(left),
                    right: Number(right),
                  });
              }}
            >
              <div className="pair-columns">
                <label>
                  First pull request
                  <select
                    value={left}
                    onChange={(e) => {
                      setLeft(e.target.value);
                      setRight('');
                      setRequest(null);
                    }}
                  >
                    <option value="">Choose an open PR</option>
                    {pulls.map((p) => (
                      <option key={p.number} value={p.number}>
                        #{p.number} {p.title} → {p.baseBranch}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Second pull request
                  <select
                    disabled={!first}
                    value={right}
                    onChange={(e) => {
                      setRight(e.target.value);
                      setRequest(null);
                    }}
                  >
                    <option value="">
                      Choose another PR{first ? ' targeting ' + first.baseBranch : ''}
                    </option>
                    {others.map((p) => (
                      <option key={p.number} value={p.number}>
                        #{p.number} {p.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="submit" disabled={!valid}>
                {request ? 'Compare latest revisions' : 'Compare revisions'}
              </button>
            </form>
            {pulls.length < 2 ? (
              <p>This repository needs two open PRs to compare.</p>
            ) : (
              first && !others.length && <p>No other open PR targets {first.baseBranch}.</p>
            )}
          </>
        )}
        {request && <PairReport key={request.run} request={request} />}
      </div>
    </WorkspaceDialog>
  );
}

function PairReport({ request }: { request: PairRequest }) {
  const [summary, setSummary] = useState<PairSummary | null>(null);
  const [analysis, setAnalysis] = useState<PairAnalysis | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState<number[]>([]);
  const [statusError, setStatusError] = useState('');
  const [checks, setChecks] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    let current = true;
    mounted.current = true;
    window.reviewer
      .preparePair(request)
      .then((result) => {
        if (current) setSummary(result);
      })
      .catch((e: unknown) => {
        if (current) setError(readableError(e));
      });
    return () => {
      current = false;
      mounted.current = false;
      void window.reviewer.closePair(request.run).catch(() => {
        /* Window shutdown also cancels the run. */
      });
    };
  }, [request]);
  useEffect(() => {
    if (!summary) return;
    let current = true,
      pending = false;
    async function check() {
      if (pending) return;
      pending = true;
      try {
        const updated = await window.reviewer.checkPair(request.run);
        if (current) {
          setChanged((previous) => [
            ...updated.changed,
            ...previous.filter((n) => updated.unknown.some((p) => p.number === n)),
          ]);
          setStatusError(updated.unknown.map((p) => '#' + p.number + ' · ' + p.reason).join(' '));
        }
      } catch (e) {
        if (current) setStatusError(readableError(e));
      } finally {
        pending = false;
      }
    }
    const refresh = () => void check();
    refresh();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [summary, request.run, checks]);
  async function investigate() {
    setError('');
    setBusy(true);
    try {
      const result = await window.reviewer.analyzePair(request.run);
      if (mounted.current) setAnalysis(result);
    } catch (e) {
      if (mounted.current) setError(readableError(e));
    } finally {
      if (mounted.current) {
        setBusy(false);
        setChecks((n) => n + 1);
      }
    }
  }
  function open(url: string) {
    window.reviewer.openChatLink(url).catch((e: unknown) => setError(readableError(e)));
  }
  function citation(pin: PairPin, ref: Excerpt) {
    const url =
      'https://github.com/' +
      request.repo +
      '/blob/' +
      ref.commit +
      '/' +
      ref.path.split('/').map(encodeURIComponent).join('/') +
      '#L' +
      ref.line;
    return (
      <div className="pair-excerpt">
        <small>
          PR #{pin.number} · {ref.change} · {ref.commit.slice(0, 8)}
        </small>
        <button
          className="secondary"
          title={'Open pinned source on GitHub · ' + ref.commit}
          onClick={() => open(url)}
        >
          {ref.path}:{ref.line}
        </button>
        <pre>{ref.text}</pre>
      </div>
    );
  }
  const gaps = [...(summary?.gaps ?? []), ...(analysis?.gaps ?? [])];
  return (
    <section aria-label="Pinned comparison">
      {error && <p role="alert">{error}</p>}
      {!summary && !error && (
        <p role="status">Pinning both revisions and comparing changed paths…</p>
      )}
      {summary && (
        <>
          <div className="pair-columns">
            {[summary.left, summary.right].map((pin) => (
              <div key={pin.number}>
                <button
                  className="secondary"
                  onClick={() => open('https://github.com/' + request.repo + '/pull/' + pin.number)}
                >
                  PR #{pin.number} · {pin.title}
                </button>
                <small>
                  Head <code title={pin.head}>{pin.head.slice(0, 8)}</code> · merge base{' '}
                  <code title={pin.mergeBase}>{pin.mergeBase.slice(0, 8)}</code>
                </small>
              </div>
            ))}
          </div>
          {!!changed.length && (
            <p role="status">
              Comparison is stale. {changed.map((n) => '#' + n).join(', ')} changed or closed.
              Compare latest revisions to refresh.
            </p>
          )}
          {statusError && (
            <p role="status">Could not verify whether these revisions are current. {statusError}</p>
          )}
          <button className="secondary" onClick={() => setChecks((n) => n + 1)}>
            Check for updates
          </button>
          <h3>Changed paths in common</h3>
          {summary.overlaps.length ? (
            <details open={summary.overlaps.length <= 8}>
              <summary>{summary.overlaps.length} shared paths</summary>
              <ul>
                {summary.overlaps.map(({ path, left, right }) => (
                  <li key={path}>
                    <details>
                      <summary>
                        <code>{path}</code>
                      </summary>
                      <div className="pair-columns">
                        {left ? (
                          citation(summary.left, left)
                        ) : (
                          <small>No sampled changed line for PR #{summary.left.number}.</small>
                        )}
                        {right ? (
                          citation(summary.right, right)
                        ) : (
                          <small>No sampled changed line for PR #{summary.right.number}.</small>
                        )}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p>No shared paths in the available diffs.</p>
          )}
          <h3>Possible interactions</h3>
          {!analysis && (
            <button disabled={busy || !!changed.length} onClick={() => void investigate()}>
              {busy ? 'Investigating…' : 'Investigate with selected agent'}
            </button>
          )}
          {analysis && (
            <>
              <small>
                {analysis.agent} ·{' '}
                {analysis.reportedModel ?? (analysis.requestedModel || 'Agent default')}
              </small>
              {!analysis.findings.length && (
                <p>No interaction identified in the inspected evidence.</p>
              )}
              {analysis.findings.map((finding, i) => (
                <article key={i} className="pair-finding">
                  <h4>Inferred consequence</h4>
                  <p>{finding.consequence}</p>
                  <div className="pair-columns">
                    {citation(summary.left, finding.left)}
                    {citation(summary.right, finding.right)}
                  </div>
                </article>
              ))}
            </>
          )}
          {!!gaps.length && (
            <>
              <h3>Evidence limits</h3>
              <ul>
                {gaps.map((gap, i) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
