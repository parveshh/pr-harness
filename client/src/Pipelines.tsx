import { FailedCheck, type SelectedFailure } from './FailedCheck.js';
import type { AttemptKey } from '../../shared/failure.js';
import { useEffect, useState } from 'react';
import {
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  CircleX,
  ExternalLink,
  LoaderCircle,
  RotateCw,
  Workflow,
} from 'lucide-react';
import { readableError } from '../../shared/assistant.js';
import {
  currentRuns,
  outcomeOf,
  overallOutcome,
  type PipelineJob,
  type PipelineOutcome,
  type PipelineRun,
  type Pipelines,
} from '../../shared/pipelines.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';

const labels: Record<PipelineOutcome | 'none', string> = {
  running: 'Running',
  queued: 'Queued',
  waiting: 'Awaiting approval',
  failed: 'Failed',
  passed: 'Passed',
  skipped: 'Skipped',
  none: 'No runs',
};
function Mark({ outcome }: { outcome: PipelineOutcome | 'none' }) {
  const size = 14;
  if (outcome === 'running') return <LoaderCircle className="spin" size={size} aria-hidden />;
  if (outcome === 'passed') return <CircleCheck size={size} aria-hidden />;
  if (outcome === 'failed') return <CircleX size={size} aria-hidden />;
  if (outcome === 'skipped') return <CircleSlash size={size} aria-hidden />;
  if (outcome === 'waiting') return <CirclePause size={size} aria-hidden />;
  return <CircleDashed size={size} aria-hidden />;
}
function took(startedAt: string | null, completedAt: string | null) {
  const seconds = Math.round((Date.parse(completedAt ?? '') - Date.parse(startedAt ?? '')) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

// Reads the GitHub Actions runs for the commit under review and keeps them fresh: often
// while something is running and the view is open, rarely otherwise.
function usePipelines(url: string, head: string, watching: boolean) {
  const [loaded, setLoaded] = useState<{ head: string; value: Pipelines; at: number } | null>(null);
  const [failure, setFailure] = useState<{ head: string; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const data = loaded?.head === head ? loaded.value : null;
  const unfinished = data?.runs.filter((run) => run.state !== 'completed').length ?? 0;
  // Each unfinished run costs a request per read, so many of them are read less often.
  const wait = unfinished
    ? watching && unfinished <= 3
      ? 10_000
      : 30_000
    : watching
      ? 60_000
      : 300_000;
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function read() {
      // Nothing is watching a hidden window. Look again when the next read is due.
      if (document.hidden) {
        timer = setTimeout(read, wait);
        return;
      }
      setBusy(true);
      window.reviewer
        .pipelines(url)
        .then((value) => {
          if (!current) return;
          setLoaded({ head: value.head, value, at: Date.now() });
          setFailure(null);
        })
        .catch((e: unknown) => {
          if (current) setFailure({ head, message: readableError(e) });
        })
        .finally(() => {
          if (!current) return;
          setBusy(false);
          timer = setTimeout(read, wait);
        });
    }
    // Opening or closing the view, pressing Refresh, or a change of pace reads at once.
    // After that each read schedules the next.
    read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [url, head, watching, wait, refresh]);
  return {
    data,
    busy,
    checkedAt: loaded?.head === head ? loaded.at : null,
    error: failure?.head === head ? failure.message : '',
    reload: () => setRefresh((n) => n + 1),
  };
}

// The PR's pipeline: a title bar button with the overall standing, and a view of every
// run, its jobs and their steps.
type ReviewRevision = Pick<AttemptKey, 'url' | 'head' | 'revision'>;
export function PipelineStatus({ url, head, revision }: ReviewRevision) {
  const [failure, setFailure] = useState<SelectedFailure | null>(null);
  const [open, setOpen] = useState(false);
  const { data, busy, checkedAt, error, reload } = usePipelines(url, head, open);
  const overall = data ? overallOutcome(data.runs) : null;
  // Only the newest run of each workflow counts towards the overall standing.
  const current = currentRuns(data?.runs ?? []);
  const summary = overall ? labels[overall] : error ? 'Unavailable' : 'Checking';
  return (
    <>
      <button
        className="secondary pipeline-trigger"
        data-outcome={overall ?? undefined}
        aria-label={'Pipeline: ' + summary}
        title="GitHub Actions runs for the commit under review"
        onClick={() => setOpen(true)}
      >
        {overall ? <Mark outcome={overall} /> : <Workflow size={14} aria-hidden />}
        <span>Checks</span>
      </button>
      {open && (
        <WorkspaceDialog
          title="Pipeline"
          icon={<Workflow size={21} />}
          wide
          onClose={() => {
            setOpen(false);
            setFailure(null);
          }}
        >
          {failure ? (
            <FailedCheck selection={failure} back={() => setFailure(null)} />
          ) : (
            <div className="pipeline-view">
              <div className="pipeline-toolbar">
                <span>
                  Commit <code>{head.slice(0, 8)}</code>
                  {overall && (
                    <>
                      {' '}
                      · <strong data-outcome={overall}>{labels[overall]}</strong>
                    </>
                  )}
                  {checkedAt && ' · checked ' + new Date(checkedAt).toLocaleTimeString()}
                </span>
                <button className="secondary" disabled={busy} onClick={reload}>
                  <RotateCw size={13} /> {busy ? 'Checking…' : 'Refresh'}
                </button>
              </div>
              {error && <p role="alert">{error}</p>}
              {!data && !error && <p role="status">Reading the runs for this commit…</p>}
              {data && !data.runs.length && (
                <p>No GitHub Actions runs were found for this commit.</p>
              )}
              {data?.runs.map((run) => (
                <RunView
                  key={run.id + ':' + run.attempt}
                  run={run}
                  superseded={!current.has(run)}
                  review={{ url, head, revision }}
                  investigate={setFailure}
                />
              ))}
              {data?.truncated && <p>Older runs for this commit are not shown.</p>}
            </div>
          )}
        </WorkspaceDialog>
      )}
    </>
  );
}

function openOnGitHub(url: string) {
  void window.reviewer.openChatLink(url).catch(() => {});
}
function RunView({
  run,
  superseded,
  review,
  investigate,
}: {
  run: PipelineRun;
  superseded: boolean;
  review: ReviewRevision;
  investigate: (selection: SelectedFailure) => void;
}) {
  const [attempt, setAttempt] = useState(run.attempt);
  const [history, setHistory] = useState<{ attempt: number; jobs: PipelineJob[] } | null>(null);
  const [problem, setProblem] = useState('');
  const [retry, setRetry] = useState(0);
  const { url, head, revision } = review;
  useEffect(() => {
    if (attempt === run.attempt) return;
    const session = crypto.randomUUID();
    let current = true;
    window.reviewer
      .pipelineAttempt({ url, head, revision, run: run.id, attempt }, session)
      .then((jobs) => {
        if (current) setHistory({ attempt, jobs });
      })
      .catch((e: unknown) => {
        if (current) setProblem(readableError(e));
      });
    return () => {
      current = false;
      void window.reviewer.closeFailure(session).catch(() => {});
    };
  }, [url, head, revision, run.id, run.attempt, attempt, retry]);
  const historical = attempt !== run.attempt;
  const jobs = historical ? (history?.attempt === attempt ? history.jobs : []) : run.jobs;
  function choose(n: number) {
    setProblem('');
    setHistory(null);
    setAttempt(n);
  }

  const outcome = outcomeOf(run);
  return (
    <section
      className="pipeline-run"
      aria-label={run.workflow + ' run ' + run.number}
      data-superseded={superseded || undefined}
    >
      <div className="pipeline-run-head">
        <span className="pipeline-mark" data-outcome={outcome}>
          <Mark outcome={outcome} />
        </span>
        <div>
          <strong>{run.workflow}</strong>
          <small>
            {labels[outcome]} · {run.event} · run #{run.number}
            {run.attempt > 1 && ' · attempt ' + run.attempt}
            {run.state === 'completed' && took(run.startedAt, run.updatedAt)
              ? ' · ' + took(run.startedAt, run.updatedAt)
              : ''}
            {superseded && ' · superseded by a newer run'}
          </small>
        </div>
        <button className="secondary" onClick={() => openOnGitHub(run.url)}>
          <ExternalLink size={13} /> Open on GitHub
        </button>
      </div>
      {run.attempt > 1 && (
        <div className="attempt-controls">
          <button
            className="secondary"
            disabled={attempt === 1}
            onClick={() => choose(attempt - 1)}
          >
            Previous attempt
          </button>
          <span>
            Jobs from attempt {attempt} of {run.attempt}
          </span>
          <button className="secondary" disabled={!historical} onClick={() => choose(attempt + 1)}>
            Next attempt
          </button>
        </div>
      )}
      {historical &&
        (problem ? (
          <p role="alert">
            {problem}{' '}
            <button
              onClick={() => {
                setProblem('');
                setRetry((n) => n + 1);
              }}
            >
              Retry jobs
            </button>
          </p>
        ) : history?.attempt !== attempt ? (
          <p role="status">Reading this attempt’s jobs…</p>
        ) : (
          !jobs.length && <p>No jobs reported for this attempt.</p>
        ))}
      {!historical && !run.jobsLoaded && <p>The jobs of this run could not be read.</p>}
      {jobs.map((job) => (
        <JobView
          key={job.id}
          job={job}
          investigate={() =>
            investigate({
              key: { ...review, run: run.id, attempt },
              workflow: run.workflow,
              number: run.number,
              job,
            })
          }
        />
      ))}
    </section>
  );
}
function JobView({ job, investigate }: { job: PipelineJob; investigate: () => void }) {
  const outcome = outcomeOf(job);
  return (
    // A job that needs attention starts open. Passed and skipped jobs start folded.
    <details className="pipeline-job" open={outcome !== 'passed' && outcome !== 'skipped'}>
      <summary>
        <span className="pipeline-mark" data-outcome={outcome}>
          <Mark outcome={outcome} />
        </span>
        <span>{job.name}</span>
        <small>
          {labels[outcome]}
          {took(job.startedAt, job.completedAt) && ' · ' + took(job.startedAt, job.completedAt)}
        </small>
      </summary>
      {outcome === 'failed' && (
        <button className="secondary" onClick={investigate}>
          Investigate failure
        </button>
      )}
      <ol>
        {job.steps.map((step) => {
          const state = outcomeOf(step);
          return (
            <li key={step.number}>
              <span className="pipeline-mark" data-outcome={state}>
                <Mark outcome={state} />
              </span>
              <span>{step.name}</span>
              <small>
                {labels[state]}
                {took(step.startedAt, step.completedAt) &&
                  ' · ' + took(step.startedAt, step.completedAt)}
              </small>
            </li>
          );
        })}
      </ol>
      {!job.steps.length && <p>No steps reported yet.</p>}
    </details>
  );
}
