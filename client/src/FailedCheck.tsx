import { useEffect, useRef, useState } from 'react';
import { readableError } from '../../shared/assistant.js';
import type {
  AttemptKey,
  FailureReport,
  FailureRange,
  FailureLocation,
} from '../../shared/failure.js';
import { outcomeOf, type PipelineJob } from '../../shared/pipelines.js';
import './failed-check.css';

export type SelectedFailure = {
  key: AttemptKey;
  workflow: string;
  number: number;
  job: PipelineJob;
};
function label(a: FailureRange) {
  return a.path + ':' + a.start + (a.end === a.start ? '' : '–' + a.end);
}
export function FailedCheck({ selection, back }: { selection: SelectedFailure; back: () => void }) {
  const { key, workflow, number, job } = selection;
  const [report, setReport] = useState<{ session: string; data: FailureReport } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    const session = crypto.randomUUID();
    let current = true;
    window.reviewer
      .investigateFailure({ ...key, job: job.id, session })
      .then((data) => {
        if (current) setReport({ session, data });
      })
      .catch((e: unknown) => {
        if (current) setError(readableError(e));
      });
    return () => {
      current = false;
      void window.reviewer.closeFailure(session).catch(() => {
        /* The main process also cancels on window close. */
      });
    };
  }, [key, job.id, retry]);
  const failedSteps = job.steps.filter((step) => outcomeOf(step) === 'failed');
  function reload() {
    setIndex(null);
    setReport(null);
    setError('');
    setRetry((n) => n + 1);
  }
  return (
    <section className="check-failure" aria-label="Failed job investigation">
      <button type="button" className="secondary" onClick={back}>
        Back to pipeline
      </button>
      <h3>{job.name}</h3>
      <p>
        {workflow} · run #{number} · attempt {key.attempt} · job #{job.id} ·{' '}
        <code title={key.head}>{key.head.slice(0, 8)}</code>
      </p>
      {failedSteps.length > 0 && <p>Failed steps · {failedSteps.map((s) => s.name).join(', ')}</p>}
      <button
        type="button"
        className="secondary"
        onClick={() => {
          window.reviewer.openChatLink(job.url).catch((e: unknown) => setError(readableError(e)));
        }}
      >
        Open original job on GitHub
      </button>
      {error && <p role="alert">{error}</p>}
      {!report && !error && <p role="status">Reading check annotations…</p>}
      {report?.data.notice && <p role="status">{report.data.notice}</p>}
      {(error || report?.data.notice) && (
        <button className="secondary" onClick={reload}>
          Retry annotations
        </button>
      )}
      {report && (
        <>
          {!report.data.annotations.length && !report.data.notice && (
            <p>
              This job reported no check annotations. Inspect the failed steps in the original job.
            </p>
          )}
          {report.data.annotations.length > 0 && (
            <>
              <h4>Runner diagnostics</h4>
              <ol className="check-diagnostics">
                {report.data.annotations.map((a, i) => (
                  <li key={i}>
                    <small>
                      {a.level} · {a.location ? label(a.location) : 'No source location'}
                    </small>
                    {a.title && <strong>{a.title}</strong>}
                    <p>{a.message}</p>
                    {a.location && (
                      <button
                        className="secondary"
                        aria-expanded={index === i}
                        onClick={() => setIndex(index === i ? null : i)}
                      >
                        {index === i ? 'Close code' : 'Inspect code'}
                      </button>
                    )}
                    {index === i && a.location && (
                      <DiagnosticCode
                        key={report.session + ':' + i}
                        session={report.session}
                        index={i}
                        annotation={a.location}
                        head={key.head}
                      />
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}
function DiagnosticCode({
  session,
  index,
  annotation,
  head,
}: {
  session: string;
  index: number;
  annotation: FailureRange;
  head: string;
}) {
  const [location, setLocation] = useState<FailureLocation | null>(null);
  const [error, setError] = useState('');
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    const request = crypto.randomUUID();
    window.reviewer
      .failureLocation(session, index, request)
      .then((result) => {
        if (current) setLocation(result);
      })
      .catch((e: unknown) => {
        if (current) setError(readableError(e));
      });
    return () => {
      current = false;
      void window.reviewer.closeFailureLocation(request).catch(() => {
        /* Window close also cancels the read. */
      });
    };
  }, [session, index]);
  useEffect(() => {
    if (location) target.current?.focus({ preventScroll: true });
  }, [location]);
  if (error) return <p role="alert">{error}</p>;
  if (!location) return <p role="status">Opening annotated code…</p>;
  if (location.kind === 'unavailable') return <p role="status">{location.reason}</p>;
  return (
    <div
      className="diagnostic-code"
      role="region"
      aria-label="Annotated code"
      tabIndex={-1}
      ref={target}
    >
      <strong>
        {location.kind === 'hunk' ? 'Changed hunk ' + location.hunk : 'Pinned source'} ·{' '}
        {label(annotation)}
      </strong>
      <small>Reviewed commit {head.slice(0, 8)}</small>
      {location.kind === 'hunk' && <code>{location.heading}</code>}
      {location.rows.map((row, i) => {
        const selected =
          row.newLine !== null && row.newLine >= annotation.start && row.newLine <= annotation.end;
        return (
          <div className="diagnostic-row" key={i} data-annotated={selected || undefined}>
            <span>{row.newLine ?? '−' + (row.oldLine ?? '')}</span>
            <code>{row.text}</code>
            {selected && (
              <span className="diagnostic-marker" aria-label="Annotated line">
                ◀
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
